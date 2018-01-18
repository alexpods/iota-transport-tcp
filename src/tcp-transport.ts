import { Server, Socket, createConnection } from 'net'
import { Serializer, Factory } from 'iota-tangle'
import { Transport, Neighbor, Data, Packer } from 'iota-gateway'
import { TcpNeighbor } from './tcp-neighbor'
import { setTimeout, clearTimeout } from 'timers';
import { removeListener } from 'cluster';

const BlockStream = require('block-stream')

const globalSerializer = new Serializer()
const globalFactory    = new Factory({ serializer: globalSerializer })
const globalPacker     = new Packer({ factory: globalFactory })

// String fmt = "%0"+String.valueOf(10)+"d";
// System.out.println(String.format(fmt, 1440));

// 0000001440

export class TcpTransport extends Transport {

  private _host: string|undefined
  private _port: number

  private _packer: Packer

  private _isRunning = false

  private _server: Server

  private _onServerConnection: ((socket: Socket) => void) | null = null
  private _onServerClose: (() => void) | null = null
  private _onServerError: ((error: any) => void) | null = null

  private _neighbors = new Set<TcpNeighbor>()

  private _reconnectionInterval: number
  private _reconnectionTimer: NodeJS.Timer|null = null
  private _neighborsToReconnect = new Set<TcpNeighbor>()

  private _receiveUnknownNeighbor: boolean

  private _sendSockets    = new Map<TcpNeighbor, Socket>()
  private _receiveSockets = new Map<TcpNeighbor, Socket>()

  constructor(params: {
    host?: string
    port: number
    packer?: Packer
    reconnectionInterval?: number
    receiveUnknownNeighbor?: boolean
  }) {
    super()
    this._host = typeof params.host !== 'undefined' ? String(params.host) : '0.0.0.0'
    this._port = Number(params.port)

    this._packer = typeof params.packer !== 'undefined' ? params.packer : globalPacker

    this._reconnectionInterval = typeof params.reconnectionInterval !== 'undefined'
      ? Number(params.reconnectionInterval)
      : 60000

    this._receiveUnknownNeighbor = Boolean(params.receiveUnknownNeighbor)

    this._server = new Server()
  }

  get isRunning(): boolean {
    return this._isRunning
  }

  supports(neighbor: Neighbor): boolean {
    return neighbor instanceof TcpNeighbor
  }

  isConnectedTo(neighbor: TcpNeighbor): boolean {
    return this._sendSockets.has(neighbor)
  }

  getNeighbor(neighborAddress: string): TcpNeighbor|null {
    for (const neighbor of this._neighbors) {
      if (neighbor.match(neighborAddress)) {
        return neighbor
      }
    }

    return null
  }

  async addNeighbor(neighbor: TcpNeighbor): Promise<void> {
    if (this._neighbors.has(neighbor)) {
      throw new Error(`Couldn't add a neighbor: the neighbor '${neighbor.address}' already exists!`)
    }

    this._neighbors.add(neighbor)

    if (this._isRunning) {
      try {
        await this._connect(neighbor)
      } catch (error) {
        this._neighborsToReconnect.add(neighbor)
      }
    }
  }

  async removeNeighbor(neighbor: TcpNeighbor): Promise<void> {
    if (!this._neighbors.has(neighbor)) {
      throw new Error(`Couldn't remove a neighbor: the neighbor '${neighbor.address}' doesn't exists!`)
    }

    if (this._receiveSockets.has(neighbor)) {
      const socket = this._receiveSockets.get(neighbor)

      socket.once("error", () => {})
      socket.destroy()

      this._receiveSockets.delete(neighbor)
    }

    if (this._sendSockets.has(neighbor)) {
      await this._disconnect(neighbor)
    }

    this._neighborsToReconnect.delete(neighbor) // TODO: Test this line
    this._neighbors.delete(neighbor)
  }

  async run(): Promise<void> {
    if (this._isRunning) {
      throw new Error('The tcp transport is already running!')
    }

    await new Promise((resolve, reject) => {
      let onListening, onError

      this._server.on('listening', onListening = () => {
        this._server.removeListener('listening', onListening)
        this._server.removeListener('error', onError)
        resolve()
      })

      this._server.on('error', onError = (error: any) => {
        this._server.removeListener('listening', onListening)
        this._server.removeListener('error', onError)
        reject(error)
      })

      this._server.listen({ host: this._host, port: this._port })
    })

    this._initServerListeners()

    const promises = new Array(this._neighbors.size)

    for (const neighbor of this._neighbors) {
      promises.push(
        this._connect(neighbor).catch(() => {
          this._neighborsToReconnect.add(neighbor)
        })
      )
    }

    await Promise.all(promises)

    this._initReconnection()

    this._isRunning = true
  }

  async shutdown(): Promise<void> {
    if (!this._isRunning) {
      throw new Error('The tcp transport is not running!')
    }

    this._destroyServerListeners()

    const promises = new Array(this._sendSockets.size)

    for (const neighbor of this._sendSockets.keys()) {
      promises.push(
        this._disconnect(neighbor)
      )
    }

    await Promise.all(promises)

    await new Promise((resolve, reject) => {
      let onClose, onError

      this._server.on('close', onClose = () => {
        this._server.removeListener('close', onClose)
        this._server.removeListener('error', onError)
        resolve()
      })

      this._server.on('error', onError = (error: any) => {
        this._server.removeListener('close', onClose)
        this._server.removeListener('error', onError)
        reject(error)
      })

      this._server.close()
    })

    this._destroyReconnection()

    this._neighborsToReconnect.clear()

    this._isRunning = false
  }


  async send(data: Data, neighbor: TcpNeighbor, address: string): Promise<void> {
    if (!neighbor.gatewayCanSendTo) {
      throw new Error(`It's restricted to send data to the neighbor with address "${neighbor.address}"!`)
    }

    const socket = this._sendSockets.get(neighbor)

    if (!socket) {
      throw new Error(`The neighbor "${neighbor.address}" is not connected!`)
    }

    await new Promise(resolve => socket.write(this._packer.pack(data), resolve))
  }


  private _initServerListeners(): void {
    let onConnection, onClose, onError

    this._server
      .on("connection", onConnection = (socket: Socket) => {
        this._receiveConnection(socket)
      })
      .on("close", onClose = () => {
        this.shutdown()
      })
      .on("error", onError = (error: any) => {
        this.emit("error", error)
      })

    this._onServerConnection = onConnection
    this._onServerClose = onClose
    this._onServerError = onError
  }

  private _destroyServerListeners(): void {
    this._server
      .removeListener('connection', this._onServerConnection)
      .removeListener('close', this._onServerClose)
      .removeListener('error', this._onServerError)

    this._onServerConnection = null
    this._onServerClose = null
    this._onServerError = null
  }

  private _initReconnection(): void {
    let reconnect

    this._reconnectionTimer = setTimeout(reconnect = async () => {
      const promises  = new Array(this._neighborsToReconnect.size)

      for (const neighbor of this._neighborsToReconnect) {
        promises.push(
          this._connect(neighbor)
            .then(() => {
              this._neighborsToReconnect.delete(neighbor)
            })
            .catch(() => {})
        )
      }

      await Promise.all(promises)

      this._reconnectionTimer = setTimeout(reconnect, this._reconnectionInterval)
    }, this._reconnectionInterval)
  }

  private _destroyReconnection(): void {
    clearTimeout(this._reconnectionTimer)
    this._reconnectionTimer = null
  }

  private async _connect(neighbor: TcpNeighbor): Promise<void> {
    const address = neighbor.address
    const port    = neighbor.port

    let socket: Socket

    await new Promise((resolve, reject) => {
      let onConnect, onError, onClose

      socket= new Socket({ writable: true })

      socket.on("connect", onConnect = () => {
        socket.removeListener("connect", onConnect)
        socket.removeListener("close", onClose)
        socket.removeListener("error", onError)

        this._initSendSocket(socket, neighbor)

        resolve()
      })

      socket.on("close", onClose = () => {
        socket.removeListener("connect", onConnect)
        socket.removeListener("close", onClose)
        socket.removeListener("error", onError)

        reject(new Error(`The connection was closed by the neighbor "${neighbor.address}"!`))
      })

      socket.on("error", onError = (error: any) => {
        socket.removeListener("connect", onConnect)
        socket.removeListener("close", onClose)
        socket.removeListener("error", onError)

        reject(error)
      })

      socket.connect({ host: address, port, family: 4 })
    })

    const portPacket = new Buffer(String(this._port).padStart(10, '0'), 'utf8')

    await new Promise(resolve => socket.write(portPacket, resolve))
  }

  private async _disconnect(neighbor: TcpNeighbor): Promise<void> {
    const socket = this._sendSockets.get(neighbor)

    await new Promise((resolve, reject) => {
      let onClose, onError

      function removeListeners() {
        socket.removeListener("close", onClose)
        socket.removeListener("error", onError)
      }

      socket.on("close", onClose = () => {
        removeListeners()
        resolve()
      })

      socket.on("error", onError = (error: any) => {
        removeListeners()
        resolve(error)
      })

      socket.destroy()
    })

    this._sendSockets.delete(neighbor)
  }

  private async _receiveConnection(socket: Socket): Promise<void> {
    let remotePort: number

    await new Promise((resolve, reject) => {
      let timeout, onData, onError, onClose

      function removeListeners() {
        socket.removeListener("data",  onData)
        socket.removeListener("close", onClose)
        socket.removeListener("error", onError)
        clearTimeout(timeout)
      }

      socket.on("data", onData = (portPacket: Buffer) => {
        removeListeners()

        // TODO: packet can contain more than just port
        // TODO: Implement proppery slicing of data

        const portString: string = portPacket.toString('utf8')

        if (portString.length !== 10 || !(/^[0-9]{10}$/).test(portString)) {
          reject(new Error(`The incorrect port is received: ${portString}!`))
        }

        remotePort = Number(portString)

        resolve()
      })

      socket.on("error", onError = (error: any) => {
        removeListeners()
        reject(error)
      })

      socket.on("close", onClose = () => {
        removeListeners()
        reject(new Error("The connection was closed!"))
      })

      timeout = setTimeout(() => {
        removeListeners()

        socket.on("error", () => {})
        socket.destroy()

        reject(new Error(`Couldn't receive the neighbor port!`))
      }, 10000)
    })

    const { address } = socket.address()

    let neighbor: TcpNeighbor

    for (const _neighbor of this._neighbors) {
      if (_neighbor.match(address)) {
        neighbor = _neighbor
        break
      }
    }

    if (!neighbor) {
      if (this._receiveUnknownNeighbor) {
        neighbor = new TcpNeighbor({ host: address, port: remotePort })
        this.addNeighbor(neighbor)
        this.emit("neighbor", neighbor)
      } else {
        socket.once("error", () => {})
        socket.destroy()
        return
      }
    }

    if (!neighbor.gatewayCanReceiveFrom) {
      socket.once("error", () => {})
      socket.destroy()
      return
    }

    this._initReceiveSocket(socket, neighbor)
  }

  private _initSendSocket(socket: Socket, neighbor: TcpNeighbor): void {
    let onError, onClose


    socket.on("error", onError = (error: any) => {
      this.emit("error", (error))
    })

    socket.on("close", onClose = () => {
      socket.removeListener("error", onError)
      socket.removeListener("close", onClose)

      socket.destroy()

      this._sendSockets.delete(neighbor)
    })

    this._sendSockets.set(neighbor, socket)
  }

  private _initReceiveSocket(socket: Socket, neighbor: TcpNeighbor): void {
    let onData, onError, onClose

    const address = socket.address().address
    const stream = socket.pipe(new BlockStream(this._packer.packetSize))

    stream.on("data", onData = (packet: Buffer) => {
      this.emit("receive", this._packer.unpack(packet), neighbor, address)
    })

    socket.on("error", onError = (error: any) => {
      this.emit("error", (error))
    })

    socket.on("close", onClose = () => {
      stream.removeListener("data",  onData)
      socket.removeListener("error", onError)
      socket.removeListener("close", onClose)

      socket.destroy()

      this._receiveSockets.delete(neighbor)
    })

    this._receiveSockets.set(neighbor, socket)
  }
}
