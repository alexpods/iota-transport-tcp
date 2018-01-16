import { expect, use } from 'chai'
import { spy, SinonSpy } from 'sinon'

use(require('chai-as-promised'))
use(require('sinon-chai'))

import { Server } from 'net'
import { Neighbor, Data } from 'iota-gateway'
import { TcpTransport } from '../src/tcp-transport'
import { TcpNeighbor } from '../src/tcp-neighbor'
import { generateTransaction, generateHash } from './utils'
import { loadavg } from 'os';
import { Packer } from 'iota-gateway/dist/packer';

describe("TcpTransport", () => {
  const localPort  = 4000
  const remotePort = 4010

  let localTransport: TcpTransport
  let localNeighbor: TcpNeighbor
  let remoteTransport: TcpTransport
  let remoteNeighbor: TcpNeighbor

  beforeEach(async () => {
    localTransport  = new TcpTransport({ port: localPort,  reconnectionInterval: 50 })
    remoteTransport = new TcpTransport({ port: remotePort })

    localNeighbor  = new TcpNeighbor({ host: '127.0.0.1', port: localPort })
    remoteNeighbor = new TcpNeighbor({ host: '127.0.0.1', port: remotePort })
  })

  afterEach(async () => {
    await Promise.all([localTransport, remoteTransport].map((t) => {
      if (t.isRunning) {
        return t.shutdown()
      }
    }))
  })

  describe("supports(neighbor)", () => {
    it("should return true for tcp neighbor", () => {
      expect(localTransport.supports(new TcpNeighbor({ host: '127.0.0.1', port: 1234 }))).to.be.true
    })

    it("should return false for any other neighbor type", () => {
      class NeighborStub extends Neighbor {
        get address() { return '127.0.0.1' }
      }

      expect(localTransport.supports(new NeighborStub())).to.be.false
    })
  })

  describe("run()", () => {
    it("should start receiving new tcp connections", async () => {
      await expect(localTransport.run()).to.be.fulfilled
    })

    it('should make isRunning flag return true', async () => {
      expect(localTransport.isRunning).to.be.false
      await expect(localTransport.run()).to.be.fulfilled
      expect(localTransport.isRunning).to.be.true
    })

    it('should be rejected if the transport is already running', async () => {
      await expect(localTransport.run()).to.not.be.rejected
      await expect(localTransport.run()).to.be.rejected
    })

    it("should try to connect to existing neighbors", async () => {
      await remoteTransport.addNeighbor(localNeighbor)
      await remoteTransport.run()

      await localTransport.addNeighbor(remoteNeighbor)

      const server: Server = remoteTransport['_server']
      const connectionListener = spy()

      server.on('connection', connectionListener)

      expect(connectionListener).to.not.have.been.called
      expect(localTransport.isConnectedTo(remoteNeighbor)).to.be.false

      await expect(localTransport.run()).to.be.fulfilled
      await new Promise(resolve => setTimeout(resolve, 10))

      expect(connectionListener).to.have.been.called
      expect(localTransport.isConnectedTo(remoteNeighbor)).to.be.true
    })

    it("should start reconnection", async () => {
      await localTransport.addNeighbor(remoteNeighbor)

      expect(localTransport.isConnectedTo(remoteNeighbor)).to.be.false

      await expect(localTransport.run()).to.be.fulfilled
      await new Promise(resolve => setTimeout(resolve, 10))

      expect(localTransport.isConnectedTo(remoteNeighbor)).to.be.false

      await remoteTransport.addNeighbor(localNeighbor)
      await remoteTransport.run()
      await new Promise(resolve => setTimeout(resolve, 200))

      expect(localTransport.isConnectedTo(remoteNeighbor)).to.be.true
    })
  })

  describe("shutdown()", () => {
    beforeEach(async () => {
      await localTransport.run()
      await remoteTransport.run()
    })

    it('should make isRunning flag return false', async () => {
      expect(localTransport.isRunning).to.be.true
      await expect(localTransport.shutdown()).to.be.fulfilled
      expect(localTransport.isRunning).to.be.false
    })

    it('should be rejected if the transport is not running', async () => {
      await expect(localTransport.shutdown()).to.not.be.rejected
      await expect(localTransport.shutdown()).to.be.rejected
    })

    it("should disconnect all existing neighbors", async () => {
      await localTransport.addNeighbor(remoteNeighbor)

      expect(localTransport.isConnectedTo(remoteNeighbor)).to.be.true

      await expect(localTransport.shutdown()).to.be.fulfilled
      await new Promise(resolve => setTimeout(resolve, 10))

      expect(localTransport.isConnectedTo(remoteNeighbor)).to.be.false
    })

    it("should stop reconnection", async () => {
      await remoteTransport.shutdown()
      await localTransport.addNeighbor(remoteNeighbor)

      expect(localTransport.isConnectedTo(remoteNeighbor)).to.be.false

      await localTransport.shutdown()

      expect(localTransport.isConnectedTo(remoteNeighbor)).to.be.false

      await remoteTransport.run()
      await new Promise(resolve => setTimeout(resolve, 200))

      expect(localTransport.isConnectedTo(remoteNeighbor)).to.be.false
    })

    it("should stop receiving new tcp connections", async () => {
      await localTransport.addNeighbor(remoteNeighbor)

      const server: Server = localTransport['_server']
      const connectionListener = spy()

      server.on('connection', connectionListener)

      expect(connectionListener).to.not.have.been.called
      expect(remoteTransport.isConnectedTo(localNeighbor)).to.be.false

      await remoteTransport.addNeighbor(localNeighbor)
      await new Promise(resolve => setTimeout(resolve, 10))

      expect(connectionListener).to.have.been.calledOnce
      expect(remoteTransport.isConnectedTo(localNeighbor)).to.be.true

      await remoteTransport.removeNeighbor(localNeighbor)
      await new Promise(resolve => setTimeout(resolve, 10))

      expect(connectionListener).to.have.been.calledOnce
      expect(remoteTransport.isConnectedTo(localNeighbor)).to.be.false

      await localTransport.shutdown()
      await new Promise(resolve => setTimeout(resolve, 10))

      expect(connectionListener).to.have.been.calledOnce
      expect(remoteTransport.isConnectedTo(localNeighbor)).to.be.false

      await remoteTransport.addNeighbor(localNeighbor)
      await new Promise(resolve => setTimeout(resolve, 10))

      expect(connectionListener).to.have.been.calledOnce
      expect(remoteTransport.isConnectedTo(localNeighbor)).to.be.false
    })
  })

  describe("addNeighbor(neighbor)", () => {
    beforeEach(async () => {
      await localTransport.run()
      await remoteTransport.run()
    })

    it("should add neighbor to the tcp transport", async () => {
      expect(localTransport.getNeighbor(remoteNeighbor.address)).to.be.null
      await expect(localTransport.addNeighbor(remoteNeighbor)).to.be.fulfilled
      expect(localTransport.getNeighbor(remoteNeighbor.address)).to.equal(remoteNeighbor)
    })

    it("should try to connect to the specified neighbor if the transport is running", async () => {
      const server: Server = remoteTransport['_server']
      const connectionListener = spy()

      server.on('connection', connectionListener)

      expect(connectionListener).to.not.have.been.called
      expect(localTransport.isConnectedTo(remoteNeighbor)).to.be.false

      await expect(localTransport.addNeighbor(remoteNeighbor)).to.be.fulfilled
      await new Promise(resolve => setTimeout(resolve, 10))

      expect(connectionListener).to.have.been.called
      expect(localTransport.isConnectedTo(remoteNeighbor)).to.be.true
    })

    it("should not be rejected if the transport fail to connect to the specified neighbor", async () => {
      await remoteTransport.shutdown()
      await expect(localTransport.addNeighbor(remoteNeighbor)).to.be.fulfilled
    })

    it("should try to reconnect later if the transport fail to connect in the first time", async () => {
      await remoteTransport.shutdown()

      expect(localTransport.isConnectedTo(remoteNeighbor)).to.be.false

      await expect(localTransport.addNeighbor(remoteNeighbor)).to.be.fulfilled
      await new Promise(resolve => setTimeout(resolve, 10))

      expect(localTransport.isConnectedTo(remoteNeighbor)).to.be.false

      await remoteTransport.run()
      await new Promise(resolve => setTimeout(resolve, 100))

      expect(localTransport.isConnectedTo(remoteNeighbor)).to.be.true
    })

    it("should be rejected if the neighbor already exists", async () => {
      await expect(localTransport.addNeighbor(remoteNeighbor)).to.be.fulfilled
      await expect(localTransport.addNeighbor(remoteNeighbor)).to.be.rejected
    })

    it("should be able to send data to the specified neighbor after adding it to the transport", async () => {
      await expect(remoteTransport.addNeighbor(localNeighbor)).to.be.fulfilled

      const receiveListener = spy()
      const data = { transaction: generateTransaction(), requestHash: generateHash() }

      remoteTransport.on('receive', receiveListener)

      await expect(localTransport.send(data, remoteNeighbor)).to.be.rejected
      await new Promise(resovle => setTimeout(resovle, 10))

      expect(receiveListener).to.not.have.been.called

      await expect(localTransport.addNeighbor(remoteNeighbor)).to.be.fulfilled

      await expect(localTransport.send(data, remoteNeighbor)).to.be.fulfilled
      await new Promise(resovle => setTimeout(resovle, 10))

      expect(receiveListener).to.have.been.called

      const [receivedData, receivedRequestedHash] = receiveListener.args[0]

      expect(receivedData.transaction.bytes.equals(data.transaction.bytes)).to.be.true
      expect(receivedData.requestHash.bytes.equals(data.requestHash.bytes.slice(0, 46))).to.be.true
    })
  })

  describe("remoteNeighbor(neighbor)", () => {
    beforeEach(async () => {
      await localTransport.run()
      await remoteTransport.run()
      await localTransport.addNeighbor(remoteNeighbor)
    })

    it("should remove the neighbor from the tcp transport", async () => {
      expect(localTransport.getNeighbor(remoteNeighbor.address)).to.equal(remoteNeighbor)
      await expect(localTransport.removeNeighbor(remoteNeighbor)).to.be.fulfilled
      expect(localTransport.getNeighbor(remoteNeighbor.address)).to.be.null
    })

    it("should disconnect from the specified neighbor", async () => {
      expect(localTransport.isConnectedTo(remoteNeighbor)).to.be.true
      await expect(localTransport.removeNeighbor(remoteNeighbor)).to.be.fulfilled
      expect(localTransport.isConnectedTo(remoteNeighbor)).to.be.false
    })

    it("should be rejected if the neighbor does not exist", async () => {
      await expect(localTransport.removeNeighbor(remoteNeighbor)).to.be.fulfilled
      await expect(localTransport.removeNeighbor(remoteNeighbor)).to.be.rejected
    })
  })

  describe("send(data, neighbor)", () => {
    let receiveListener: SinonSpy
    let data: Data

    beforeEach(async () => {
      await localTransport.addNeighbor(remoteNeighbor)
      await remoteTransport.addNeighbor(localNeighbor)

      await localTransport.run()
      await remoteTransport.run()
      await new Promise(resolve => setTimeout(resolve, 100))

      remoteTransport.on("receive", receiveListener = spy())

      data = { transaction: generateTransaction(), requestHash: generateHash() }
    })

    it("should send data to the specified neighbor", async () => {
      expect(receiveListener).to.not.have.been.called

      await expect(localTransport.send(data, remoteNeighbor)).to.be.fulfilled
      await new Promise(resolve => setTimeout(resolve, 10))

      expect(receiveListener).to.have.been.called

      const [receivedData, receivedRequestedHash] = receiveListener.args[0]

      expect(receivedData.transaction.bytes.equals(data.transaction.bytes)).to.be.true
      expect(receivedData.requestHash.bytes.equals(data.requestHash.bytes.slice(0, 46))).to.be.true
    })

    it("should be rejected if the specified neighbor is not connected", async () => {
      expect(receiveListener).to.not.have.been.called

      await expect(localTransport.send(data, new TcpNeighbor({ host: '127.0.0.1', port: 4500 }))).to.be.rejected
      await new Promise(resolve => setTimeout(resolve, 10))

      expect(receiveListener).to.not.have.been.called
    })
  })
})
