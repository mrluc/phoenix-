g          = require 'gulp'
browserify = require 'browserify'
babelify   = require 'babelify'
request    = require 'request'
source     = require 'vinyl-source-stream'
fs         = require 'fs'

PHOENIX_VERSION = '1.0.2'
_url = 'https://raw.githubusercontent.com/phoenixframework/phoenix/v__VSN__/web/static/js/phoenix.js'
versioned_url = (vsn)-> _url.replace "__VSN__", vsn

builder   = ->
  stream = browserify("./src/phoenix.js", debug: true )
    .transform babelify
    .bundle()
    .on "error", (err) -> console.log "Error : " + err.message
    .pipe source "phoenix.js"
    .pipe g.dest "./lib"

downloader = ->
  request( versioned_url( PHOENIX_VERSION ))
    .pipe fs.createWriteStream "./src/phoenix.js"

g.task 'download',            -> downloader()
g.task 'build', ['download'], -> builder()
g.task 'default', ['build']
