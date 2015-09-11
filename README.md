### phoenix-js-derp: a temporary phoenix.js for npm

Elixir, Phoenix ... what could be better? Start it up, and with a
few lines of backend and frontend code, you're using Channels.

Now, sure, some of us are using a different setup than
the default Phoenix frontend, which is Brunch.
And one thing that would be great is if we could easily use the
phoenix.js file
as an NPM module, since NPM is the most successful package manager out there
and lots of us package our js that way.

[That'll be coming!](https://github.com/phoenixframework/phoenix/issues/827)
But there are a lot of other priorities for Phoenix right
now, because its future is So Bright. And a conf is coming up, and so forth.

So this is a little module that just does one thing: it lets you
require phoenix.js, almost as if the future has already happened.

`npm install --save phoenix-js-derp`

And then enjoy your tasty Phoenix! Useful if you're using Browserify, etc.

```

    Phoenix = require('phoenix-js-derp');

    chan = Phoenix.channel ...

```

Once Phoenix.js has its own npm package, rename it in those two places.

### Development

This thing has a little script that downloads, and then babelifies a
phoenix.js file from github based on a git tag.


### ... why?

I put this together over about a half hour ... as of nnnnnnnnnnnnOW,
just because I was bummed out that I was managing dependencies with
vendored js files, and I figured that I could keep it in sync with
current phoenix until the official package is out -- in which case, I
just remove "`-derp`" in 2 places and I'm gtg.
