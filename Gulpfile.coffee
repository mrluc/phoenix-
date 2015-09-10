g          = require 'gulp'
del        = require 'del'
source     = require 'vinyl-source-stream'

fs         = require "fs"
browserify = require "browserify"
babelify   = require "babelify"

request    = require 'request'

PHOENIX_VERSION = "1.0.2"
_url = "https://raw.githubusercontent.com/phoenixframework/phoenix/v__VSN__/web/static/js/phoenix.js"
versioned_url = (vsn)-> _url.replace "__VSN__", vsn

builder = ->
  browserify("./src/phoenix.js", debug: true )
    .transform babelify
    .bundle()
    .on "error", (err) -> console.log "Error : " + err.message
    .pipe fs.createWriteStream "./lib/phoenix.js"

g.task 'download', ->
  
  request versioned_url( PHOENIX_VERSION )
    .pipe fs.createWriteStream './lib/phoenix.js'

g.task 'build', ['download'], -> builder()

g.task 'default', -> builder()




  
