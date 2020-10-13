/* jshint asi: true, esversion: 6, node: true, laxbreak: true, laxcomma: true, undef: true, unused: true */

const APCaccess  = require('apcaccess')
    , NodeCache  = require('node-cache')
    , debug      = require('debug')('apcupsd')
    , inherits   = require('util').inherits
    , moment     = require('moment')
    , underscore = require('underscore')


module.exports = function (homebridge) {
  const Characteristic = homebridge.hap.Characteristic
      , Service = homebridge.hap.Service
      , CommunityTypes = require('hap-nodejs-community-types')(homebridge)

  homebridge.registerAccessory("homebridge-accessory-apcupsd", "apcupsd", APC)

  const cache = new NodeCache({ stdTTL: 1 })

  function APC(log, config) {
    if (!(this instanceof APC)) return new APC(log, config)

    this.log = log
    this.config = config || { accessory: 'apcupsd' }

    this.name = this.config.name

    if (!this.config.subtype) this.config.subtype = 'battery'
    if ([ 'battery', 'power' ].indexOf(this.config.subtype) === -1) throw new Error('invalid subtype: ' + this.config.subtype)

    this.options = underscore.defaults(this.config.options || {}, { ttl: 600, verboseP: false })
    if (this.options.ttl < 10) this.options.ttl = 600
    debug('options', this.options)

    this.location = require('url').parse('http://' + this.config.location + '/')
    if (!this.location.port) {
      this.location.port = 3551
      this.location.host += ':' + this.location.port
    }

    this.whoami = { location: this.location.host, subtype: this.config.subtype }


    const now = moment().unix()

    this.historyExtra = { lastReset: now - moment('2001-01-01T00:00:00Z').unix(), lastChange: now }
    if (this.config.subtype === 'power') {
      underscore.extend(this.historyExtra, { wattSeconds: 0, totalSamples: 1, lastSample: now })
    } else {
      underscore.extend(this.historyExtra, 
                        { timesOpened    :  0
                        , openDuration   :  0
                        , closedDuration :  0
                        , lastActivation :  0
                        , lastStatus     : -1
                        })
    }

    this.statusFault = Characteristic.StatusFault.NO_FAULT
    this.callbacks = []
  }

/* getStatusJson().then(status)

{ "UPSNAME": "alarmpi"                         // UPS name from EEPROM or configuration
, "MODEL": "Back-UPS ES 700G"                  // UPS model derived from UPS information
, "LINEV": "232.0 Volts"                       // Current input line voltage
, "LOADPCT": "5.0 Percent"                     // Percentage of UPS load capacity used
, "BCHARGE": "100.0 Percent"                   // Current battery capacity charge percentage
, "OUTPUTV": "219.7 Volts"                     // Current UPS output voltage
, "OUTCURNT": "239.50 Amps"                    // Current UPS output amperage
, "ITEMP": "31.5 C"                            //
, "BATTV": "13.5 Volts"                        // Current battery voltage
, "STATFLAG": "0x05000008"                     // UPS status flag in hex
                                               // 0x08: on line
                                               // 0x10: on battery
                                               // 0x20: overloaded output
                                               // 0x40: battery low
                                               // 0x80: replace battery
, "SERIALNO": "5B1325T16968"                   // UPS serial number
, "FIRMWARE": "871.O2 .I USB FW:O2"            // UPS firmware version
, "NOMPOWER": "1500 Watts"                     // Nominal power
, ...
}
 */

  APC.prototype =
  { fetchStatus:
    function (callback) {
      const self = this

      if (!callback) callback = () => {}
      cache.get(self.location.host + '_status', (err, status) => {
        if (err || status) return callback(err, status)

        self._fetchStatus((err, result) => {
          const i = (value) => {
            const integer = value && parseInt(value)

            if (!isNaN(integer)) return integer
          }

          const p = (value) => {
            const percentage = value && parseFloat(value.split(' ')[0])

            if ((!isNaN(percentage)) && (0 <= percentage) && (percentage <= 100)) return percentage
          }

          const r = (value) => {
            const real = value && parseFloat(value.split(' ')[0])

            if (!isNaN(real)) return real
          }

          const s = (value) => {
            return value.split('/').join(' ')
          }

          const t = (value) => {
            return s(value.split('.')[0])
          }

          const z =
          { BATTV    : r
          , BCHARGE  : p
          , FIRMWARE : t
          , ITEMP    : r
          , LINEV    : r
          , LOADPCT  : p
          , MODEL    : s
          , NOMPOWER : r
          , OUTPUTV  : r
          , OUTCURNT : r
          , SERIALNO : s
          , STATFLAG : i
          , UPSNAME  : s
          }

          self.statusFault = (err || (!result)) ? Characteristic.StatusFault.GENERAL_FAULT : Characteristic.StatusFault.NO_FAULT
          err = null

          const status = {}
          for (let key in z) {
            let value = result && result[key] && result[key].trim()

            if ((!z.hasOwnProperty(key)) || (value === undefined)) continue

            value = z[key](value)
            if (value !== undefined) status[key] = value
          }

//        debug('fetchStatus', underscore.extend({}, self.whoami, { status }))

          if (!self.initP) {
//          debug('fetchStatus', underscore.extend({}, self.whoami, { status: 'initialized' }))
            self.initP = true

            if (self.config.subtype === 'power') {
              if (status.NOMPOWER) {
                self.myPowerService
                  .getCharacteristic(CommunityTypes.Watts).on('get', self.getWatts.bind(self))
                self.myPowerService
                  .getCharacteristic(CommunityTypes.KilowattHours).on('get', self.getKilowattHours.bind(self))
              }
              if (status.OUTPUTV) {
                self.myPowerService
                  .getCharacteristic(CommunityTypes.Volts).on('get', self.getOutputVoltageAC.bind(self))
              }
              if (status.OUTCURNT) {
                self.myPowerService
                  .getCharacteristic(CommunityTypes.VoltAmperes).on('get', self.getOutputVoltAmperes.bind(self))
              }
              if (status.ITEMP) {
                self.myPowerService
                  .getCharacteristic(Characteristic.CurrentTemperature).on('get', self.getCurrentTemperature.bind(self))
              }
            }
          }

          const now = moment().unix()
          const delta = now - self.historyExtra.lastChange

          if ((self.config.subtype === 'power') && (status.NOMPOWER !== undefined) && (status.LOADPCT !== undefined)) {
            const gap = now - self.historyExtra.lastSample
            const power = Math.round((status.NOMPOWER * status.LOADPCT) / 100.0)

            if (delta >= this.options.ttl) {
              self.history.addEntry({ time: now, power })
              self.historyExtra.lastChange = now
            }

            if (gap > 0) {
              self.historyExtra.wattSeconds += power * gap
              self.historyExtra.totalSamples += gap
              self.historyExtra.lastSample = now
/*
              self.historyExtra.average = ((power * gap) / self.historyExtra.totalSamples)
              self.historyExtra.power = power
              self.historyExtra.gap = gap
 */
//            debug('fetchStatus', underscore.extend({}, self.whoami, { historyExtra: self.historyExtra }))
            }
          }

          if ((self.config.subtype === 'battery') && (status.STATFLAG !== undefined)) {
            const contact = Characteristic.ContactSensorState[(status.STATFLAG & 0x08) ? 'CONTACT_DETECTED'
                                                                                       : 'CONTACT_NOT_DETECTED']

            self.history.addEntry({ time: now, status: contact })

            if (self.historyExtra.lastStatus !== contact) {
              self.historyExtra.lastStatus = contact
              if (contact == Characteristic.ContactSensorState.CONTACT_NOT_DETECTED) {
                self.historyExtra.timesOpened++
                self.historyExtra.closedDuration += delta
                self.historyExtra.lastActivation = now - self.history.getInitialTime()
              } else {
                self.historyExtra.openDuration += delta
              }
              self.historyExtra.lastChange = now
              self.history.setExtraPersistedData(self.historyExtra)
//            debug('fetchStatus', underscore.extend({}, self.whoami, { historyExtra: self.historyExtra }))
            }
          }

          debug('set ' + self.location.host + '_status cache: ' + JSON.stringify(status, null, 2))
          cache.set(self.location.host + '_status', status)
          callback(err, status)
        })
      })
    }

  , _fetchStatus:
    function (callback) {
      const self = this

      const flush = (err, result) => {
        const callbacks = self.callbacks

        self.callbacks = []
        self.client = null
        for (let cb of callbacks) {
          try {
            cb(null, result)
          } catch (ex) {
            self.log.error('callback error: ' + ex.stack)
          }
        }
      }

      if (!self.client) {
        self.client = new APCaccess()
        self.client.connect(self.location.hostname, self.location.port).then(() => {
//        debug('fetchStatus', underscore.extend({}, self.whoami, { status: 'connected' }))
          return self.client.getStatusJson()
        }).then((result) => {
          const client = self.client

          flush(null, result)
          return client.disconnect()
        }).then(() => {
//        debug('fetchStatus', underscore.extend({}, self.whoami, { status: 'disconnected' }))
        }).catch((err) => {
          self.log.error('getStatusJSON error: ' + err.toString())
          flush(err)
        })
      }

      self.callbacks.push(callback)
    }

  , loadExtra:
    function () {
      let extra

      if (!this.history.isHistoryLoaded()) return setTimeout(this.loadExtra.bind(this), 100)

      extra = this.history.getExtraPersistedData()
      if (extra) this.historyExtra = extra
      else this.history.setExtraPersistedData(this.historyExtra)
//    debug('fetchStatus', underscore.extend({}, this.whoami, { historyExtra: this.historyExtra }))
    }

  , getName:
    function (callback) {
      const self = this

      self.fetchStatus(function (err, status) {
        callback(err, (status && status.UPSNAME) || self.name)
      })
    }

  , getModel:
    function (callback) {
      const self = this

      self.fetchStatus(function (err, status) {
        callback(err, (status && status.MODEL) || self.config.model)
      })
    }

  , getSerialNumber:
    function (callback) {
      const self = this

      self.fetchStatus(function (err, status) {
        callback(err, (status && status.SERIALNO) || self.config.serialNo)
      })
    }

  , getFirmwareRevision:
    function (callback) {
      const self = this

      self.fetchStatus(function (err, status) {
        callback(err, ((status && status.FIRMWARE) || self.config.firmware))
      })
    }

  , getInputVoltageAC:
    function (callback) {
      this.fetchStatus(function (err, status) {
        callback(err, status && status.LINEV)
      })
    }

  , getBatteryVoltageDC:
    function (callback) {
      this.fetchStatus(function (err, status) {
        callback(err, status && status.BATTV)
      })
    }

  , getUPSLoadPercent:
    function (callback) {
      this.fetchStatus(function (err, status) {
        callback(err, status && status.LOADPCT)
      })
    }

  , getVolts:
    function (callback) {
      this.fetchStatus(function (err, status) {
        callback(err, status && (status.OUTPUTV || status.LINEV))
      })
    }

  , getVoltAmperes:
    function (callback) {
      this.fetchStatus(function (err, status) {
// TBD: 

        callback(err, 0)
      })
    }

  , getWatts:
    function (callback) {
      this.fetchStatus(function (err, status) {
        const power = status && status.NOMPOWER
        const percentage = status && status.LOADPCT

        if ((err) || (power === undefined) || (percentage === undefined)) return callback(err)

        callback(err, (power * percentage) / 100.0)
      })
    }

  , getKilowattHours:
    function (callback) {
      callback(null, (this.historyExtra.wattSeconds * 3600) / (this.historyExtra.totalSamples * 1000))
    }

  , getOutputVoltageAC:
    function (callback) {
      this.fetchStatus(function (err, status) {
        callback(err, status && status.OUTPUTV)
      })
    }

  , getOutputVoltAmperes:
    function (callback) {
      this.fetchStatus(function (err, status) {
        callback(err, status && status.OUTCURNT)
      })
    }

  , getCurrentTemperature:
    function (callback) {
      this.fetchStatus(function (err, status) {
        callback(err, status && status.ITEMP)
      })
    }

  , getContactSensorState:
    function (callback) {
      this.fetchStatus(function (err, status) {
        let flags = status && status.STATFLAG

        if ((err) || (flags === undefined)) flags = 0x00
        callback(err, Characteristic.ContactSensorState[(flags & 0x08) ? 'CONTACT_DETECTED' : 'CONTACT_NOT_DETECTED'])
      })
    }

  , getStatusActive:
    function (callback) {
      this.fetchStatus(function (err, status) {
        let percentage = status && status.LOADPCT

        if ((err) || (percentage === undefined)) percentage = 0
        callback(err, Characteristic.Active[percentage ? 'ACTIVE' : 'INACTIVE'])
      })
    }

  , getStatusFault:
    function (callback) {
      callback(null, this.statusFault)
    }

  , getEveTimesOpened:
    function (callback) {
      callback(null, this.historyExtra.timesOpened)
    }

  , getEveOpenDuration:
    function (callback) {
      callback(null, this.historyExtra.openDuration)
    }

  , getEveClosedDuration:
    function (callback) {
      callback(null, this.historyExtra.closedDuration)
    }

  , getEveLastActivation:
    function (callback) {
      callback(null, this.historyExtra.lastActivation)
    }

  , getEveResetTotal:
    function (callback) {
      this.history.getCharacteristic(CommunityTypes.EveResetTotal).updateValue(this.historyExtra.lastReset)
      callback(null, this.historyExtra.lastReset)
    }

  , setEveResetTotal:
    function (value, callback) {
      if (this.config.subtype === 'battery') this.historyExtra.timesOpened = 0
      this.historyExtra.lastReset = value
      this.history.setExtraPersistedData(this.historyExtra)
      this.history.getCharacteristic(CommunityTypes.EveResetTotal).updateValue(this.historyExtra.lastReset)
      callback(null)
    }

  , getBatteryFail:
    function (callback) {
      this.fetchStatus(function (err, status) {
        let flags = status && status.STATFLAG

        if ((err) || (flags === undefined)) flags = 0x80
        callback(err, Characteristic.SecuritySystemCurrentState[(flags & 0x80) ? 'ALARM_TRIGGERED' : 'STAY_ARM'])
      })
    }

  , getBatteryLevel:
    function (callback) {
      this.fetchStatus(function (err, status) {
        let percentage = status && status.BCHARGE

        if ((err) || (percentage === undefined)) percentage = 100
        callback(err, percentage)
      })
    }

  , getChargingState:
    function (callback) {
      this.fetchStatus(function (err, status) {
        const percentage = status && status.BCHARGE
        let flags = status && status.STATFLAG

        if ((err) || (flags === undefined) || (percentage === undefined)) flags = 0x80
        callback(err, Characteristic.ChargingState[(flags & 0x80)                          ? 'NOT_CHARGEABLE'
                                                : ((flags & 0x10) || (percentage === 100)) ? 'NOT_CHARGING'
                                                :                                            'CHARGING'])
      })
    }

  , getStatusLowBattery:
    function (callback) {
      this.fetchStatus(function (err, status) {
        let flags = status && status.STATFLAG

        if ((err) || (flags === undefined)) flags = 0x00
        callback(err, Characteristic.StatusLowBattery[(flags & 0x40) ? 'BATTERY_LEVEL_LOW' : 'BATTERY_LEVEL_NORMAL'])
      })
    }

  , getServices: function () {
      const FakeGatoHistoryService = require('fakegato-history')(homebridge)
          , myAccessoryInformation = new Service.AccessoryInformation()
      const services = [ myAccessoryInformation ]
      let interval, myPowerService, myContactService, myBatteryService, myAlarmService

      myAccessoryInformation
        .setCharacteristic(Characteristic.Name, this.name)
        .setCharacteristic(Characteristic.Manufacturer, "American Power Conversion (APC)")
      myAccessoryInformation
        .getCharacteristic(Characteristic.Name)
        .on('get', this.getName.bind(this))
      if (this.config.model) myAccessoryInformation.setCharacteristic(Characteristic.Model, this.config.model)
      myAccessoryInformation
        .getCharacteristic(Characteristic.Model)
        .on('get', this.getModel.bind(this))
      if (this.config.serialNo) myAccessoryInformation.setCharacteristic(Characteristic.SerialNumber, this.config.serialNo)
      myAccessoryInformation
        .getCharacteristic(Characteristic.SerialNumber)
        .on('get', this.getSerialNumber.bind(this))
      if (this.config.firmware) myAccessoryInformation.setCharacteristic(Characteristic.FirmwareRevision, this.config.firmware)
      myAccessoryInformation
       .getCharacteristic(Characteristic.FirmwareRevision)
       .on('get', this.getFirmwareRevision.bind(this))

      if (this.config.subtype === 'power') {
        const PowerService = function (displayName, subtype) {
          Service.call(this, displayName, '00000001-0000-1000-8000-135D67EC4377', subtype)
          this.addCharacteristic(CommunityTypes.InputVoltageAC)
          this.addCharacteristic(CommunityTypes.BatteryVoltageDC)
          this.addCharacteristic(CommunityTypes.UPSLoadPercent)
          this.addCharacteristic(CommunityTypes.Volts)
          this.addCharacteristic(CommunityTypes.VoltAmperes)
          this.addOptionalCharacteristic(CommunityTypes.Watts)
          this.addOptionalCharacteristic(CommunityTypes.KilowattHours)
          this.addOptionalCharacteristic(CommunityTypes.OutputVoltageAC)
          this.addOptionalCharacteristic(CommunityTypes.OutputVoltAmperes)
          this.addOptionalCharacteristic(Characteristic.CurrentTemperature)
          this.addCharacteristic(CommunityTypes.EveResetTotal)
        }
        inherits(PowerService, Service)

        myPowerService = new PowerService()
        this.myPowerService = myPowerService
        myPowerService
          .getCharacteristic(CommunityTypes.InputVoltageAC)
          .on('get', this.getInputVoltageAC.bind(this))
        myPowerService
          .getCharacteristic(CommunityTypes.BatteryVoltageDC)
          .on('get', this.getBatteryVoltageDC.bind(this))
        myPowerService
          .getCharacteristic(CommunityTypes.UPSLoadPercent)
          .on('get', this.getUPSLoadPercent.bind(this))
        myPowerService
          .getCharacteristic(CommunityTypes.Volts)
          .on('get', this.getVolts.bind(this))
        myPowerService
          .getCharacteristic(CommunityTypes.VoltAmperes)
          .on('get', this.getVoltAmperes.bind(this))
        myPowerService
          .getCharacteristic(CommunityTypes.EveResetTotal)
          .on('get', this.getEveResetTotal.bind(this))
          .on('set', this.setEveResetTotal.bind(this))
        services.push(myPowerService)

        this.displayName = this.name + ' Power'
        this.history = new FakeGatoHistoryService('energy', this, {
          storage      : 'fs',
          disableTimer : true,
          length       : Math.pow(2, 14),
          path         : homebridge.user.cachedAccessoryPath(),
          filename     : this.location.host + '-apcupsd-power_persist.json'
        })

        interval = 1
      } else {
        myContactService = new Service.ContactSensor()
        myContactService.addOptionalCharacteristic(CommunityTypes.EveTimesOpened)
        myContactService.addOptionalCharacteristic(CommunityTypes.EveOpenDuration)
        myContactService.addOptionalCharacteristic(CommunityTypes.EveClosedDuration)
        myContactService.addOptionalCharacteristic(CommunityTypes.EveLastActivation)
        myContactService.addOptionalCharacteristic(CommunityTypes.EveResetTotal)
        myContactService
          .getCharacteristic(Characteristic.ContactSensorState)
          .on('get', this.getContactSensorState.bind(this))
        myContactService
          .getCharacteristic(Characteristic.StatusActive)
          .on('get', this.getStatusActive.bind(this))
        myContactService
          .getCharacteristic(Characteristic.StatusFault)
          .on('get', this.getStatusFault.bind(this))
        myContactService
          .getCharacteristic(CommunityTypes.EveTimesOpened)
          .on('get', this.getEveTimesOpened.bind(this))
        myContactService
          .getCharacteristic(CommunityTypes.EveOpenDuration)
          .on('get', this.getEveOpenDuration.bind(this))
        myContactService
          .getCharacteristic(CommunityTypes.EveClosedDuration)
          .on('get', this.getEveClosedDuration.bind(this))
        myContactService
          .getCharacteristic(CommunityTypes.EveLastActivation)
          .on('get', this.getEveLastActivation.bind(this))
        myContactService
          .getCharacteristic(CommunityTypes.EveResetTotal)
          .on('get', this.getEveResetTotal.bind(this))
          .on('set', this.setEveResetTotal.bind(this))
        services.push(myContactService)

        myAlarmService = new Service.SecuritySystem()
        myAlarmService
            .setCharacteristic(Characteristic.Name, this.name + ' Fail')
        myAlarmService
          .getCharacteristic(Characteristic.SecuritySystemCurrentState)
          .on('get', this.getBatteryFail.bind(this))
        services.push(myAlarmService)

        myBatteryService = new Service.BatteryService()
        myBatteryService
          .getCharacteristic(Characteristic.BatteryLevel)
          .on('get', this.getBatteryLevel.bind(this))
        myBatteryService
          .getCharacteristic(Characteristic.ChargingState)
          .on('get', this.getChargingState.bind(this))
        myBatteryService
          .getCharacteristic(Characteristic.StatusLowBattery)
          .on('get', this.getStatusLowBattery.bind(this))
        services.push(myBatteryService)

        this.displayName = this.name + ' Battery'
        this.history = new FakeGatoHistoryService('door', this, {
          storage      : 'fs',
          disableTimer : true,
          length       : Math.pow(2, 14),
          path         : homebridge.user.cachedAccessoryPath(),
          filename     : this.location.host + '-apcupsd-battery_persist.json'
        })

        interval = this.options.ttl
        this.loadExtra() // not used for 'power' subtype
      }
      this.history.subtype = this.config.subtype
      services.push(this.history)

      setTimeout(this.fetchStatus.bind(this), 1 * 1000)
      setInterval(this.fetchStatus.bind(this), interval * 1000)

      return services
    }
  }
}
