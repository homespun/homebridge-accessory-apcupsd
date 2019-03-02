# homebridge-accessory-apcupsd
An [apcupsd](http://www.apcupsd.org/) accessory plugin for [Homebridge](https://github.com/nfarina/homebridge).

# Installation
Run these commands:

    % sudo npm install -g homebridge
    % sudo npm install -g homebridge-accessory-apcupsd

On Linux, you might see this output for the second command:

    npm ERR! pcap@2.0.0 install: node-gyp rebuild
    npm ERR! Exit status 1
    npm ERR!

If so, please try

    % apt-get install libpcap-dev

and try

    % sudo npm install -g homebridge-accessory-apcupsd

again!

NB: If you install homebridge like this:

    sudo npm install -g --unsafe-perm homebridge

Then all subsequent installations must be like this:

    sudo npm install -g --unsafe-perm homebridge-accessory-apcupsd

# Configuration
Edit `~/.homebridge/config.json`, inside `"accessories": [ ... ]` add:

    { "accessory" : "apcupsd"
    , "name"      : "apcupsd"
    , "location"  : "a.b.c.d"

    // optional, here are the defaults
    , "options"   : { "ttl": 600, "verboseP" : false }
    }

If the value of the `"name"` property is `"abcpsd"`,
then the accessory's name is automatically taken from `apcupsd`
(either from the UPS' EEPROM or from the `UPSNAME` value in the `apcupsd` server's configuration).

The IP address (`"a.b.c.d"`) is where `apcupsd` is running.
The default port number is `3351`,
and can be changed by adding it to the `location` value, e.g., `"a.b.c.d:p"`).

# Many Thanks
Many thanks to [ToddGreenfield](https://github.com/ToddGreenfield) author of
[homebridge-nut](https://github.com/ToddGreenfield/homebridge-nut).

Many thanks to [mapero](https://github.com/mapero) author of [apcaccess](https://github.com/mapero/apcaccess).

