'use strict'
const cc = require('five-bells-condition')

function base64url (b) {
  return b.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

function conditionToRipple (c) {
  const condition = new cc.Condition()
  condition.setTypeId(0)
  condition.setCost(32)
  condition.setHash(Buffer.from(c, 'base64'))

  return condition
    .serializeBinary()
    .toString('hex')
    .toUpperCase()
}

function rippleToCondition (r) {
  const condition = cc
    .Condition
    .fromBinary(Buffer.from(r, 'hex'))

  return base64url(condition.getHash())
}

function fulfillmentToRipple (f) {
  const fulfillment = new cc.PreimageSha256()
  fulfillment.setPreimage(Buffer.from(f, 'base64'))

  return fulfillment
    .serializeBinary()
    .toString('hex')
    .toUpperCase()
}

function rippleToFulfillment (r) {
  const fulfillment = cc
    .PreimageSha256
    .fromBinary(Buffer.from(r, 'hex'))

  // TODO: is a function exposed for this?
  return base64url(fulfillment.preimage)
}

module.exports = {
  base64url,
  conditionToRipple,
  rippleToCondition,
  fulfillmentToRipple,
  rippleToFulfillment
}
