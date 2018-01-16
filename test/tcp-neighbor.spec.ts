import { expect } from 'chai'
import { TcpNeighbor } from '../src/tcp-neighbor'

describe("TcpNeighbor", () => {
  let neighbor: TcpNeighbor

  beforeEach(() => {
    neighbor = new TcpNeighbor({ host: 'google.com', port: 80 })
  })

  describe("match(neighborAddress)", () => {
    it("should return true if address is equal to the neighbor's host", () => {
      expect(neighbor.match("google.com")).to.be.true
    })
  })
})
