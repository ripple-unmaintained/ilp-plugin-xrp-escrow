#!/usr/bin/env node
var keypairs = require('ripple-keypairs')

const seed = keypairs.generateSeed()
const keypair = keypairs.deriveKeypair(seed)
const address = keypairs.deriveAddress(keypair.publicKey)
console.log({
  secret: seed,
  account: address,
  keypair
})
