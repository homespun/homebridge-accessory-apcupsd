# homebridge-accessory-apcupsd
An [apcupsd](http://www.apcupsd.org/) accessory plugin for [Homebridge](https://github.com/nfarina/homebridge).

# Installation
Run these commands:

    % sudo npm install -g homebridge
    % sudo npm install -g homebridge-accessory-apcupsd

NB: If you install homebridge like this:

    sudo npm install -g --unsafe-perm homebridge

Then all subsequent installations must be like this:

    sudo npm install -g --unsafe-perm homebridge-accessory-apcupsd

# Install, Configure, and Test apcupsd
This plugin won't work until you have [apcupsd](http://www.apcupsd.org/) running in your network.
I found this
[tutorial](http://www.anites.com/2013/09/monitoring-ups.html#How%20to%20monitor%20a%20UPS%20with%20a%20Raspberry%20Pi)
enlightening.

If you are running [homebridge](https://github.com/nfarina/homebridge) on a different platform than `apcupsd`,
then you must edit `/etc/apcupsd/apcupsd.conf` and change

    NISIP 127.0.0.1
    
to 

    NISIP 0.0.0.0

By default, the `apcupsd` server will listen on

    NISPORT 3551

Also make sure you have

    NETSERVER on

## Monitoring Multiple UPS Devices
By default,
a single UPS is monitored via the USB cable;
however,
you can monitor multiple UPS devices on the same platform,
but the configuration depends on the platform.
For example,
using the Debian [instructions](https://wiki.debian.org/apcupsd#Configuring_.28Multiple_UPS_Devices.29) on my system:

     # lsusb
    Bus 001 Device 006: ID 051d:0002 American Power Conversion Uninterruptible Power Supply
    Bus 001 Device 005: ID 051d:0002 American Power Conversion Uninterruptible Power Supply
    ...
     
    # udevadm info --attribute-walk --name=/dev/usb/hiddev0 | egrep 'manufacturer|product|serial'
    ATTRS{manufacturer}=="American Power Conversion"
    ATTRS{product}=="Back-UPS RS 1500G FW:865.L7 .D USB FW:L7 "
    ATTRS{serial}=="4B1848P19501  "
    ...

    # udevadm info --attribute-walk --name=/dev/usb/hiddev1 | egrep 'manufacturer|product|serial'
    ATTRS{manufacturer}=="American Power Conversion"
    ATTRS{product}=="Back-UPS RS 1500MS FW:952.e3 .D USB FW:e3     "
    ATTRS{serial}=="3B1812X23721  "
    ...

    # cat >> /etc/udev/rules.d/ups.rules <<EOF
    KERNEL=="hiddev*", ATTRS{manufacturer}=="American Power Conversion", ATTRS{serial}=="3B1812X23721  ", OWNER="root", SYMLINK+="usb/ups-computers"
    KERNEL=="hiddev*", ATTRS{manufacturer}=="American Power Conversion", ATTRS{serial}=="4B1848P19501  ", OWNER="root", SYMLINK+="usb/ups-monitors"
    EOF
    
    # udevadm trigger --verbose --sysname-match=hiddev*
    
    # cd /etc/apcupsd
    # mv apcupsd.conf apcupsd.conf.old
    # cp apcupsd.conf.old apcupsd-computers.conf
    # cp apcupsd.conf.old apcupsd-monitors.conf

    # vi apcupsd-computers.conf
      ... change UPSNAME to computers
      ... change DEVICE to /dev/usb/ups-computers
      ... change EVENTSFILE to /var/log/apcupsd-computers.events
      ... change SCRIPTDIR ... (if set)
      ... change PWRFAILDIR ... (if set)
      ... change STATFILE ... (if set)

    # vi apcupsd-monitors.conf
      ... change UPSNAME to monitors
      ... change DEVICE to /dev/usb/ups-monitors
      ... change EVENTSFILE to /var/log/apcupsd-monitors.events
      ... change SCRIPTDIR ... (if set)
      ... change PWRFAILDIR ... (if set)
      ... change STATFILE ... (if set)
      ... change NISPORT to 3552

The change to `NISPORT` is **very** important as it will change the port number that the instance listens on.

The tricky part is to have `apcupsd` invoked properly by whaterver system control facility you are using.

My system uses [systemctl](http://man7.org/linux/man-pages/man1/systemctl.1.html):

    # cp /lib/systemd/system
    # mv apcupsd.service apcupsd.service.old
    # cat > apcupsd\@.service <<EOF
    [Unit]
    Description=UPS '%I' power management daemon
    Documentation=man:apcupsd(8)

    [Service]
    ExecStartPre=/lib/apcupsd/prestart
    ExecStart=/sbin/apcupsd -f /etc/apcupsd/apcupsd-%i.conf -P /var/run/apcupsd-%i.pid
    Type=forking
    KillMode=process
    PIDFile=/var/run/apcupsd-%i.pid

    [Install]
    WantedBy=multi-user.target
    EOF

    # systemctl enable apcupsd@computers.service
    # systemctl start apcupsd@computers.service

    # systemctl enable apcupsd@monitors.service
    # systemctl start apcupsd@monitors.service

# Configuration
Edit `~/.homebridge/config.json`, inside `"accessories": [ ... ]` add:

    { "accessory" : "apcupsd"
    , "name"      : "..."
    , "location"  : "a.b.c.d"

    // optional, here are the defaults
    , "subtype"   : "battery"
    , "options"   : { "ttl": 600, "verboseP" : false }

    , "model"     : "..."
    , "serialNo"  : "..."
    , "firmware"  : "..."
    }

## Location
The IP address (`"a.b.c.d"`) is where `apcupsd` is running.
The default port number is `3551`,
and can be changed by adding it to the `location` value, e.g., `"192.168.1.109:3552"`.

## Subtype
By default,
the plugin will report on the battery in the UPS (i.e., `"subtype" : "battery"`);
however, you can also have it report on the power instead (i.e., `"subtype" : "power"`).

If you want both reports,
create two accessories different values for `name` (obviously!),
but with the same `location` value:

      { "accessory" : "apcupsd"
      , "name"      : "... Battery"
      , "location"  : "a.b.c.d"
      , "subtype"   : "battery"
      }
    ,
      { "accessory" : "apcupsd"
      , "name"      : "... Power"
      , "location"  : "a.b.c.d"
      , "subtype"   : "power"
      }

Please note that the `power` subtype is **experimental**.
At present,
there's no mechanism to get Volt-Amperes from the UPS (`0` is always reported).
More importantly,
Kilowatt-Hours is based on sampling Watt-Seconds.

## Name, Model, Serial Number, and Firmware Revision
Although the plugin successfully retrieves these values from `apcusbd`,
the plugin can not provide the modified values.
A [PR](https://github.com/nfarina/homebridge/pull/2169) has been submitted with a possible fix.
Until then,
I suggest you run

    % apcaccess

and add the values for `UPSNAME`, `MODEL`, `SERIALNO`, and `FIRMWARE` to the `config.json` file.

# Many Thanks
Many thanks to [ToddGreenfield](https://github.com/ToddGreenfield) author of
[homebridge-nut](https://github.com/ToddGreenfield/homebridge-nut).

Many thanks to [mapero](https://github.com/mapero) author of [apcaccess](https://github.com/mapero/apcaccess).

