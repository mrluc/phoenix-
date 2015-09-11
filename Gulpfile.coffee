g          = require 'gulp'
request    = require 'request'
fs         = require 'fs'
sourcemaps = require 'gulp-sourcemaps'
babel      = require 'gulp-babel'
concat     = require 'gulp-concat'
    
PHOENIX_VERSION = '1.0.2'
_url = 'https://raw.githubusercontent.com/phoenixframework/phoenix/v__VSN__/web/static/js/phoenix.js'
URL = _url.replace "__VSN__", PHOENIX_VERSION

g.task "download", ->
  request( URL )
    .pipe fs.createWriteStream "./src/phoenix.js"

g.task "build", ["download"], ->
  g.src "./src/phoenix.js"
    .pipe sourcemaps.init()
    .pipe babel()
    .pipe concat "phoenix.js"
    .pipe sourcemaps.write "."
    .pipe g.dest "./lib"

g.task 'default', ['build']
