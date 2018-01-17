import { Server, Socket, createConnection } from 'net'
import { Serializer, Factory } from 'iota-tangle'
import { Transport, Neighbor, Data, Packer } from 'iota-gateway'
import { TcpNeighbor } from './tcp-neighbor'
import { setTimeout, clearTimeout } from 'timers';

const BlockStream = require('block-stream')

const globalSerializer = new Serializer()
const globalFactory    = new Factory({ serializer: globalSerializer })
const globalPacker     = new Packer({ factory: globalFactory })

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

  private _sendSockets    = new Map<TcpNeighbor, Socket>()
  private _receiveSockets = new Map<TcpNeighbor, Socket>()

  constructor(params: {
    host?: string
    port: number
    packer?: Packer
    reconnectionInterval?: number
  } = {}) {
    super()
    this._host = typeof params.host !== 'undefined' ? String(params.host) : undefined
    this._port = Number(params.port)

    this._packer = typeof params.packer !== 'undefined' ? params.packer : globalPacker

    this._reconnectionInterval = typeof params.reconnectionInterval !== 'undefined'
      ? Number(params.reconnectionInterval)
      : 60000

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

    if (this._isRunning) {
      try {
        await this._connectNeighbor(neighbor)
      } catch (error) {
        this._neighborsToReconnect.add(neighbor)
      }
    }

    this._neighbors.add(neighbor)
  }

  async removeNeighbor(neighbor: TcpNeighbor): Promise<void> {
    if (!this._neighbors.has(neighbor)) {
      throw new Error(`Couldn't remove a neighbor: the neighbor '${neighbor.address}' doesn't exists!`)
    }

    if (this._sendSockets.has(neighbor)) {
      await this._disconnectNeighbor(neighbor)
    }

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
        this._connectNeighbor(neighbor).catch(() => {
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
        this._disconnectNeighbor(neighbor)
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

    this._isRunning = false
  }


  async send(data: Data, neighbor: TcpNeighbor): Promise<void> {
    const socket = this._sendSockets.get(neighbor)

    if (!socket) {
      throw new Error(`The neighbor "${neighbor.address}" is not connected!`)
    }

    await new Promise(resolve => socket.write(this._packer.pack(data), resolve))
  }


  private _initServerListeners(): void {
    let onConnection, onClose, onError

    this._server
      .on('connection', onConnection = (socket: Socket) => {
        const { address } = socket.address()

        let neighbor: TcpNeighbor

        for (const _neighbor of this._neighbors) {
          if (_neighbor.match(address)) {
            neighbor = _neighbor
            break
          }
        }

        if (!neighbor) {
          /* TODO: Implement "neighbor not found" logic */
          return
        }

        this._initReceiveSocket(socket, neighbor)
      })
      .on('close', onClose = () => {
        console.log('CLOSE ===>', this._port)
      })
      .on('error', onError = (error: any) => {
        console.log('ERROR', error)
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
          this._connectNeighbor(neighbor)
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

  private _initReceiveSocket(socket: Socket, neighbor: TcpNeighbor): void {
    let onData, onError, onClose

    const stream = socket.pipe(new BlockStream(this._packer.packetSize))

    stream.on("data", onData = (packet: Buffer) => {
      this.emit("receive", this._packer.unpack(packet), neighbor)
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

  private async _connectNeighbor(neighbor: TcpNeighbor): Promise<void> {
    const address = neighbor.address
    const port    = neighbor.port

    let socket: Socket

    await new Promise((resolve, reject) => {
      let onConnect, onError

      socket= new Socket({ writable: true })

      socket.on('connect', onConnect = () => {
        socket.removeListener('connect', onConnect)
        socket.removeListener('error', onError)
        resolve(socket)
      })

      socket.on('error', onError = (error: any) => {
        socket.removeListener('connect', onConnect)
        socket.removeListener('error', onError)
        reject(error)
      })

      socket.connect({ host: address, port })
    })

    this._sendSockets.set(neighbor, socket)
  }

  private async _disconnectNeighbor(neighbor: TcpNeighbor): Promise<void> {
    const socket = this._sendSockets.get(neighbor)

    await new Promise((resolve, reject) => {
      let onClose, onError

      socket.on("close", onClose = () => {
        socket.removeListener("close", onClose)
        socket.removeListener("error", onError)
        resolve()
      })

      socket.on("error", onError = (error: any) => {
        socket.removeListener("close", onClose)
        socket.removeListener("error", onError)
        reject(error)
      })

      socket.destroy()
    })

    this._sendSockets.delete(neighbor)
  }
}
