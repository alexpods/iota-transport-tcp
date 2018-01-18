import { Neighbor } from 'iota-gateway'

export class TcpNeighbor extends Neighbor {
  private _host: string
  private _port: number

  private _gatewayCanSendTo: boolean
  private _gatewayCanReceiveFrom: boolean

  constructor(params: {
    host:    string
    port:    number
    send?:    boolean
    receive?: boolean
  }) {
    super()

    this._host = String(params.host)
    this._port = Number(params.port)

    this._gatewayCanSendTo = typeof params.send !== 'undefined' ? Boolean(params.send) : true
    this._gatewayCanReceiveFrom = typeof params.receive !== 'undefined' ? Boolean(params.receive) : true
  }

  get address(): string {
    return this._host
  }

  get port(): number {
    return this._port
  }

  get gatewayCanSendTo(): boolean {
    return this._gatewayCanSendTo
  }

  get gatewayCanReceiveFrom(): boolean {
    return this._gatewayCanReceiveFrom
  }


  match(neighborAddress: string): boolean {
    return neighborAddress === this._host
  }
}
