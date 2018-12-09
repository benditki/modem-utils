const serialport = require('serialport')
const fs = require('fs')
const Ractive = require('ractive')
const GSM = require('./gsm.js')
const util = require('util')

gsms = {}

const scan_ports = util.promisify(serialport.list)

localStorage.debug = "" //"=D="

function $(id) { return document.getElementById(id) }

var ractive = new Ractive({
    el: 'body',
    template: '#page-tpl',
    data: {
        stats: {},
        logs: {},
        gsm: {},
        show_grid: false,
        state_class(gsm) {
            if (gsm.done) {
                return 'done'
            }
            if (gsm.state >= 1) return 'wip'
        },
        sim_stats(sim_id) {
            return this.get("stats.sim" + sim_id)
        },
        format_time(ts) { return ts.toLocaleTimeString('en-GB') },
        regist_avg(attempts) {
            if (!attempts || attempts.length == 0) return 0
            return attempts.reduce((res, attempt) =>
                    res + (attempt.regist.end - attempt.regist.start) / 1000, 0) / attempts.length
        },
        acq_ip_avg(attempts) {
            if (!attempts || attempts.length == 0) return 0
            return attempts.reduce((res, attempt) =>
                    res + (attempt.acq_ip.end - attempt.acq_ip.start) / 1000, 0) / attempts.length
        }
    },
    carousel() { return `<div class="dot-carousel"></div>` },
    waiting: (label) => { return `
        <i class="la-line-scale-pulse-out-rapid la-dark la-sm"><div></div><div></div><div></div><div></div><div></div></i>
        <span class="progress">${label}</span>
        <i class="la-line-scale-pulse-out-rapid la-dark la-sm"><div></div><div></div><div></div><div></div><div></div></i>`
    },
    on: {
        async restart(context, port_name) {
            console.log("restarting", port_name)
            var gsm = gsms[port_name]
            if (gsm) {
                await gsm.command("AT+CFUN=15")
            }
        }
    },
    format_countdown(ts) {
        var left = Math.round((ts - Date.now()) / 1000)
        var fractions = []
        for (factor of [60, 60, 24]) {
            if (fractions.length >= 2 && !left) {
                break
            }
            fractions.push(left % factor)
            left = Math.floor(left / factor)
        }
        if (fractions.length < 2 || left) {
            fractions.push(left)
        }
        fractions = fractions.map((f, i, a) => ( i < 2 && i < a.length - 1 ? f.toString().padStart(2, '0') : f ))
        return fractions.reverse().join(':')
    }

});

var baudrate_map = {}

try {
    baudrate_map = JSON.parse(localStorage.baudrate_map)
}
catch (e) {
    if (!e instanceof SyntaxError) {
        throw e
    }
}

window.onbeforeunload = function () {
    localStorage.baudrate_map = JSON.stringify(baudrate_map)
}
window.ractive = ractive


function log(port_name, type, msg) {
    var item = { port: port_name, type: type, msg: msg}
    if (msg.startsWith('ERROR: ') || msg.startsWith('< +CME ERROR:')) {
        item.error = true
    }
    
    ractive.push(`logs.${port_name}`, item)
}

var desired_baudrate = 921600

function make_first(first, list) {
    var res = [first]
    for (var item of list) {
        if (item != first) {
            res.push(item)
        }
    }
    return res
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


async function connect(port_name) {
    var baudrates = [115200, 921600]
    if (baudrate_map[port_name]) {
        baudrates = make_first(baudrate_map[port_name], baudrates)
    }
    var key = "gsm." + port_name + "."
    var gsm = gsms[port_name]
    try {
        await ractive.set(key + "done", false)
        await ractive.set(key + "state", 0)
        baudrate = await gsm.connect(port_name, baudrates)
        
        await ractive.set(key + "active_baudrate", baudrate)
        await ractive.set(key + "state", 1)

        if (baudrate != desired_baudrate) {
            await gsm.command(`AT+IPR=${desired_baudrate}`)
            baudrate = await gsm.connect(port_name, make_first(desired_baudrate, baudrates))
            await gsm.command("AT&W")
            await gsm.restart()
        }
        
        baudrate_map[port_name] = baudrate
        
        await ractive.set(key + "active_baudrate", baudrate)
        await ractive.set(key + "state", 2)
        
        var response;
        response = await gsm.command("ATI")
        await ractive.set(key + "model", response.body)
        response = await gsm.command("AT+GSN")
        await ractive.set(key + "sn", response.body)
        await ractive.set(key + "state", 3)
        
        response = await gsm.command("AT+UPSND=0,8")
        var gprs_activated = response.status == "1"
        if (!gprs_activated) {
            await gsm.command("AT+UPSDA=0,2")
        }

        response = await gsm.command("AT+UPSD=0,1;+UPSD=0,7;&V")
        if (response.apn != "mobileye8" || response.stored_ip != "0.0.0.0" ||
                response.flow_control != "0" || response.echo != "0" || response.verbose != "0") {
            if (gprs_activated) {
                await gsm.command("AT+UPSDA=0,4")
            }
            await gsm.command("ATE0;V0;&K0;&W;+UPSD=0,1,\"mobileye8\";+UPSD=0,7,\"0.0.0.0\";+UPSDA=0,1")
            await gsm.restart()
            await gsm.command("AT+UPSDA=0,2")
            response = await gsm.command("AT+UPSD=0,1;+UPSD=0,7")
        }
            
        await ractive.set(key + "apn", response.apn)
        await ractive.set(key + "static_ip", response.stored_ip)

        response = await gsm.CCID()
        await ractive.set(key + "sim_id", response.sim_id)
        await ractive.set(key + "state", 4)
        
        
        if (response.sim_id) {
            var stat_key = "stats.sim" + response.sim_id
            await ractive.push(stat_key + ".test", new Date())
            await ractive.set(key + "state", 5)
            
            var regist_start = null
            
            while (true) {
                response = await gsm.command("AT+UCGOPS?;+CGATT?", {
                    /*response_valid: response => response && response.operator && response.network && response.gprs_attached == "1",*/
                    repeat: 1
                    /*timeout: 2000*/
                })
                if (response && response.operator && response.network && response.gprs_attached == "1") break;
                
                if (!regist_start) {
                    regist_start = new Date()
                    ractive.push(stat_key + ".logs", {ts: regist_start, msg: "== start registration =="})
                }
                await sleep(2000);
            }
            
            var regist_end = new Date()
            
            if (regist_start) {
                ractive.push(stat_key + ".logs", {ts: regist_end, msg: `registered to ${response.operator}`})
            }
            
            await ractive.set(key + "operator", response.operator)
            await ractive.set(key + "network", response.network)
            await ractive.set(key + "gprs_attached", response.gprs_attached == "1")
            await ractive.set(key + "state", 6)

            var acq_ip_start = null
            response = await gsm.command("AT+UPSND=0,8")
            if (response.status == "0") {
                acq_ip_start = new Date()
                response = await gsm.activateData();
            }

            response = await gsm.command("AT+UPSND=0,0")
            await ractive.set("current_ip", response.ip)
            await ractive.set(key + "state", 7)
            
            var acq_ip_end = new Date()
            
            if (regist_start && acq_ip_start) {
                ractive.push(stat_key + ".logs", {ts: acq_ip_end, msg: `got IP ${response.ip}`})
                ractive.push(stat_key + ".attempts", {
                    regist: { start: regist_start, end: regist_end },
                    acq_ip: { start: acq_ip_start, end: acq_ip_end }
                })
            }
            
        }
        
        await ractive.set(key + "restart_ts", Date.now() + 5 * 1000)
        await ractive.set(key + "done", true)
            
        setTimeout(check, 200, port_name)
    }
    catch (e) {
        log(port_name, "system", "ERROR: " + e.message)
        disconnect(port_name)
    }
}

async function disconnect(port_name) {
    await gsms[port_name].disconnect()
    delete gsms[port_name]
}

async function check(port_name) {
    if (!gsms[port_name]) return;
    try {
        var restarted = false;
        var restart_ts_key = 'gsm.' + port_name + '.restart_ts'
        if (ractive.get(restart_ts_key)) {
            var left = ractive.get(restart_ts_key) - Date.now()
            if (left > 0) {
                await ractive.update(restart_ts_key, { force: true })
            } else {
                await gsms[port_name].command("AT+CFUN=15")
                ractive.set(restart_ts_key, null)
                restarted = true
            }
        }
        if (!restarted) {
            await gsms[port_name].command("AT", {timeout: 200, repeat: 1})
        }
        setTimeout(check, 400, port_name)
    } catch (e) {
        log(port_name, "system", "ERROR: " + e.message)
        await disconnect(port_name)
    }
}

async function refresh_ports() {
    var exclude_ports = ["COM1", "COM26"]
    var ports = await scan_ports()

    var port_names = [];
    for (port of ports) {
        if (exclude_ports.includes(port.comName)) continue;
        port_names.push(port.comName)
    }

    for (var port_name of port_names) {
        if (!gsms[port_name]) {
            let port_name_clone = port_name.slice(0)
            var gsm = new GSM((type, msg) => log(port_name_clone, type, msg))
            gsms[port_name] = gsm
            connect(port_name)
        }
    }
    
    for (var port_name in gsms) {
        if (gsms[port_name]) {
            if (!port_names.includes(port_name)) {
                await disconnect(port_name)
                delete ractive.get('gsm')[port_name]
                await ractive.update('gsm.' + port_name)
            }
        }
    }
}

setInterval(refresh_ports, 200)
