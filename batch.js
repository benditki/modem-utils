const serialport = require('serialport')
const fs = require('fs')
const Ractive = require('ractive')
const GSM = require('./gsm.js')
const util = require('util')

gsms = {}

const scan_ports = util.promisify(serialport.list)

localStorage.debug = "=D="

function $(id) { return document.getElementById(id) }

var ractive = new Ractive({
    el: 'body',
    template: '#page-tpl',
    data: {
        show_grid: false,
    },

    stored: [],

    async oninit() {
        for (var keypath of this.stored) {
            try {
                if (localStorage[keypath]) {
                    this.set(keypath, JSON.parse(localStorage[keypath]))
                }
            } catch (e) {
                if (e instanceof SyntaxError) {
                    this.set(keypath, localStorage[keypath])
                } else {
                    throw e
                }
            }
        }

    },
});

window.onbeforeunload = function () {
    for (keypath of ractive.stored) { 
        localStorage[keypath] = ractive.get(keypath) || ''
    }
}
window.ractive = ractive


function log(msg) {
    var p = document.createElement("p")
    p.innerText = msg
    if (msg.startsWith('ERROR: ') || msg.startsWith('< +CME ERROR:')){
        p.classList.add('error')
    } else if (msg.startsWith('< ')) {
        p.classList.add('received')
    } else if (msg.startsWith('> ')) {
        p.classList.add('sent')
    }
    var elem = $('log')
    elem.appendChild(p)
    elem.scrollTop = elem.scrollHeight
}

async function connect(port_name) {
    var baudrates = [115200, 921600]
    var key = "gsm." + port_name + "."
    var gsm = gsms[port_name]
    try {
        await ractive.set(key + "state", 0)
        baudrate = await gsm.connect(port_name, baudrates)
        
        await ractive.set(key + "active_baudrate", baudrate)
        await ractive.set(key + "state", 1)
        
        var response;
        response = await gsm.command("ATI")
        await ractive.set(key + "model", response.body)
        response = await gsm.command("AT+GSN;+CCID")
        await ractive.set(key + "sn", response.body)
        await ractive.set(key + "sim_id", response.sim_id)
        await ractive.set(key + "state", 2)

        response = await gsm.command("AT+UCGOPS?;+CGATT?", {
            response_valid: response => response && response.operator && response.network && response.gprs_attached == "1",
            timeout: 2000
        })
        await ractive.set("operator", response.operator)
        await ractive.set("network", response.network)
        await ractive.set("gprs_attached", response.gprs_attached == "1")
        await ractive.set(key + "state", 3)

        response = await gsm.command("AT+UPSND=0,8")
        if (response.status == "0") {
            await gsm.command("AT+UPSDA=0,2")
        }

        response = await gsm.command("AT+UPSD=0,1;+UPSD=0,7")
        await ractive.set("stored_apn", response.apn)
        await ractive.set("current_apn", response.apn)
        await ractive.set("stored_ip", response.stored_ip)
        await ractive.set(key + "state", 4)

        response = await gsm.command("AT+UPSND=0,8")
        if (response.status == "0") {
            await gsm.command("AT+UPSDA=0,3")
        }

        response = await gsm.command("AT+UPSND=0,0")
        await ractive.set("current_ip", response.ip)
        await ractive.set(key + "state", 5)
        
        setTimeout(check, 200, port_name)
    }
    catch (e) {
        log("ERROR: " + e.message)
        disconnect(port_name)
    }
}

async function disconnect(port_name) {
    await gsms[port_name].disconnect()
    gsms[port_name] = null
}

async function check(port_name) {
    try {
        await gsms[port_name].AT()
        setTimeout(check, 200, port_name)
    } catch (e) {
        log("ERROR: " + e.message)
        disconnect(port_name)
    }
}

async function refresh_ports() {
    var exclude_ports = ["COM1"]
    var port_names = (await scan_ports()).map(port => port.comName)
    
    for (var port_name of port_names.filter(name => !exclude_ports.includes(name))) {
        if (!gsms[port_name]) {
            var gsm = new GSM(log)
            gsms[port_name] = gsm
            connect(port_name)
        }
    }
    
    setTimeout(refresh_ports, 200)
}

setImmediate(refresh_ports)
