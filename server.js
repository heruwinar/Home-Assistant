//-------------NPM modules and Variables------------------------//
var fs = require('fs');
var http = require('http');
var https = require('https');
var express = require('express');
var app = express();
var options = {  
    key: fs.readFileSync('./https_key.pem', 'utf8'),  
    cert: fs.readFileSync('./https_cert.crt', 'utf8')  
}; 
var open = require('open');
var multer = require('multer');
var upload = multer({dest: '/plexpass/'});
var schedule = require('node-schedule');
var scheduledFunctions = [];


//-------------API imports and Variables------------------------//
const { Client } = require('tplink-smarthome-api');
const TPClient = new Client();
var prox;
const NetgearRouter = require('netgear');
var ngrouter;
var routerDetails;
var harmony = require('harmonyhubjs-client');
const TuyAPI = require('tuyapi');

//-------------Google Imports and Variables---------------------//
//const readline = require('readline');
const { google } = require('googleapis');
let google_oauth;


//-------------personal modules--------------------------------//
var file_tools = require('./file_tools.js');
var device_tools = require('./device_tools.js');
var prox_tools = require('./prox_tools.js');
var google_tools = require('./google_tools.js');
var module_tools = require('./module_tools.js');


//-------------Program Variables------------------------------//
const programPath = __dirname;
let settings;
var modulesPath = './modules.json';
var devicesPath = './devices.json'; 
var activitiesPath = './activities.json';
var profilesPath = './profiles.json';
var devices = [];
var modules = {};
var activities = [];
var profiles = [];

file_tools.readJSONFile(profilesPath).then(function(profileList) {
    profiles = profileList;
});


//process all modules in the modules.json file
file_tools.readJSONFile(modulesPath).then(function(moduleList) {
       
    moduleList.forEach(function(type) {

        if (type.moduleName == 'proxmox') {
            try {
                prox = require('proxmox')(type.details.user, type.details.password, type.details.ip);
                modules.prox = prox;
                console.log('Proxmox connected Successfully');
            } catch(err) {
                console.log(err);
            }            
        } else if (type.moduleName == 'google') {
            file_tools.readJSONFile(type.details.credentials).then(function (content) {
                const {client_secret, client_id, redirect_uris} = content.installed;
                google_oauth = new google.auth.OAuth2(
                    client_id, client_secret, redirect_uris[0]);
                
                google_tools.authorize(type.details, google_oauth);
            });
        } else if (type.moduleName == 'netgear') {
            modules.netgearRouter =  new NetgearRouter(type.details.password, type.details.user, type.details.host, type.details.port);
            modules.netgearRouter.routerDetails = modules.netgearRouter.discover().then(discovered => {
                console.log('Netgear Router connected successfully');
                checkWhoIsHome();
                setInterval(checkWhoIsHome, 300000);
                return discovered;
            }).catch(err => console.log(err));
        } else if (type.moduleName == 'harmony') {
            modules.harmony = {};
            harmony(type.details.host).then(function(hub) {
                modules.harmony.hub = hub;

                modules.harmony.hub.getAvailableCommands().then(function(rawCommands) {
                    var tempHarmonyDevice;

                    var harmonyDevices = []; //what will be set to modules.harmony.devices
                    rawCommands.device.forEach(function(rawDevice) {
                        tempHarmonyDevice = {
                            name: rawDevice.label,
                            deviceProto: 'harmony',
                            deviceKind: 'harmony-'+rawDevice.type,
                            deviceType: rawDevice.type,
                            ip: "",
                            groups: [],
                            controlPort: rawDevice.ControlPort,
                            manufacturer: rawDevice.manufacturer,
                            harmonyProfile: rawDevice.deviceProfileUri,
                            deviceModel: rawDevice.model,
                            isManualPower: rawDevice.isManualPower,
                            controlGroups: []
                        };
                        rawDevice.controlGroup.forEach(function(cg) {
                            tempCG = {
                                name: cg.name,
                                controls: []
                            };
                            cg.function.forEach(function(ctrl) {
                                tempCG.controls.push({
                                    name: ctrl.name,
                                    command: ctrl.action,
                                    formattedCommand: ctrl.action.replace(/\:/g, '::')
                                });
                            });
                            tempHarmonyDevice.controlGroups.push(tempCG);
                        });
                        harmonyDevices.push(tempHarmonyDevice);
                        var inDevices = false;
                        devices.forEach(function(d) {
                            if (d.name === tempHarmonyDevice.name)
                                inDevices = true;
                        });
                        //only push to devices if the device is new, so harmony devices can be 
                        //stored and further customized in the program
                        //devices are saved to devices.json after being added once
                        if (!inDevices)
                            devices.push(tempHarmonyDevice);
                    });
                    modules.harmony.devices = harmonyDevices;
                });
            }).catch(err => console.log(err));
            console.log('Harmony Hub connected successfully');
        }
    });
}); 

process.on('exit', function(code) {
    console.log('exit code: ' + code);
    modules.harmony.hub.end();
    var writableDevices = device_tools.getWritableDevices(devices);
    file_tools.writeJSONFile('./devices.json', writableDevices, function() {console.log('saved devices')});
    //file_tools.writeJSONFile('./modules.json', modules, function() {console.log('saved modules')});
    setTimeout(console.log('safely exiting the program'), 5000);
});

//reads devices.json for list of controlled devices
file_tools.readJSONFile(devicesPath).then(function(deviceList) {
    deviceList.forEach(function(device) {
        var tempDevice;
        try {
            tempDevice = device;
            if (device.deviceKind === 'tplink-plug') 
                tempDevice.obj = TPClient.getPlug({host: device.ip});
            else if (device.deviceKind === 'tplink-bulb') 
                tempDevice.obj = TPClient.getBulb({host: device.ip});
            else if (device.deviceProto === 'harmony') {
                //don't think I need to do anything here but saving this space in case I do
            } else if (device.deviceProto === 'tuyapi') {
                tempDevice.obj = new TuyAPI({
                    id: device.id,
                    key: device.key,
                    ip: device.ip
                });
            }
            devices.push(tempDevice);
            console.log(tempDevice.deviceKind + ' ' + tempDevice.name + ' conected successfully');
        } catch (err) {
            console.log(err);
        }
    });
});

//loads activities and schedules repetitive activities
file_tools.readJSONFile(activitiesPath).then(function(activityList) {
    activities = activityList;
    activities.filter((eachActivity) => {
        return eachActivity.triggers.timeofday !== undefined;
    }).map((scheduledActivity) => {
        var cronStr = scheduledActivity.triggers.timeofday;
        var j = schedule.scheduleJob(cronStr, device_tools.runActivity(modules, activities, devices, scheduledActivity.name));
        scheduledFunctions.push(j);
    });
});

function checkWhoIsHome() {
    //var attachedDevices;
    console.log('checking who is home');
    
    modules.netgearRouter.getAttachedDevices().then((attached) => {
        profiles.forEach(function(profile) {
            var profileDevices = attached.filter((attd) => {
                return profile.identifiers.ip.includes(attd.IP)
            });
            profile.strength = profileDevices.length;
            profile.devices = profileDevices;
        });
    });
}





var nonsecureServer = http.createServer(app).listen(9875);
var secureServer = https.createServer(options, app).listen(9876);

//----------------Device API

app.route('/api/devices/list').get((req, res) => {
    
    var dev_list = devices.map((d, ind) => {
        return {
            name: d.name, 
            proto: d.deviceProto,
            groups: d.groups,
            deviceID: ind
        };
    })
    console.log(dev_list);
    res.send(dev_list);
});


app.route('/api/devices/:deviceID/info').get((req, res) => {
    var index = parseInt(req.params.deviceID);
    if (devices[index].deviceProto === 'tplink') {
        devices[index].getSysInfo().then(function (deviceInfo) {
            res.json(deviceInfo);
        }).catch(function (reason) {
            res.send(reason);
        });
    }
});


app.route('/api/devices/:deviceID/set/:state').get((req, res) => {
    var index = parseInt(req.params.deviceID);
    var device = devices[index];
    if (device === undefined) {
        res.send('requested device doesn\'t exist!');
        return;
    }
    var state = req.params.state === '1' ? true : (req.params.state === '0' ? false : undefined);
    
    state = device_tools.setDeviceState(device, state, modules);
    res.send("device " + index + ' turned ' + (state == true ? 'on' : 'off'));
});

app.route('/api/groups/:control').get((req, res) => {
    var groups = req.query.groups;
    var control = parseInt(req.params.control);
    var controlGroup = [];

    devices.forEach(function(device) {              //for each device loaded in program
        var isInGroup = true;                       //whether or not the device is in the specified group
        groups.forEach(function(g) {                //for each group in the request
            if (isInGroup && device.groups.indexOf(g) == -1)   //if the group from the request is not in the devices groups
                isInGroup = false;
        });
        if (isInGroup)                              //if it is, push it to controlGroup
            controlGroup.push(device);
    })

    switch (control) {
        case 0: //turn off group
            controlGroup.forEach(function(device) {
                device_tools.setDeviceState(device, false, modules);
            });
            break;
        case 1: //turn on group
            controlGroup.forEach(function(device) {
                device_tools.setDeviceState(device, true, modules);
            });
            break;
        case 2: //toggle group
            controlGroup.forEach(function(device) {
                device_tools.setDeviceState(device, undefined, modules);
            });
            break;
        default:
            res.send('no control implemented for ', control);
    }
    res.send('success');
});

app.route('/api/activities/:name').get((req, res) => {
    device_tools.runActivity(modules, activities, devices, req.params.name);
    res.sendStatus(200);
});

//returns the list of people at the house
app.route('/api/people/list').get((req, res) => {
    res.json(profiles);
})

//-----------------Google API

app.route('/oauth2/google').get((req, res) => {
    var token_code = req.query.code;
    var scope_oauth = req.query.scope;
    res.send(google_tools.saveAccessToken(google_oauth, token_code));
});

app.route('/api/modules/google/cal/upcoming').get((req, res) => {
    google_tools.getGCalEvents(google_oauth, 15).then(function (events) {
        res.json(events);
    }).catch(function (reason) {
        res.send(reason);
    });
});

app.route('/api/modules/google/gmail/labels').get((req, res) => {
    google_tools.getGmailLabels(google_oauth);
    res.sendStatus(200);
});

//-------------------------Netgear API

app.route('/api/netgearrouter/attached').get((req, res) => {
    modules.netgearRouter.login();
    modules.netgearRouter.getAttachedDevices().then(function(attached) {
        res.send(attached);
        console.log(attached);
    });
});

app.route('/api/netgearrouter/info').get((req, res) => {
    modules.netgearRouter.getInfo().then(function(info) {
        res.send(info);
        console.log(info);
    });
});

//-------------Harmony API

app.route('/api/modules/harmony/devices').get((req, res) => {
    res.json(modules.harmony.devices);
});

app.route('/api/modules/harmony/control/:device_name/:control_group/:control').get((req, res) => {
    var selectedControl = device_tools.getHarmonyControl(modules, req.params.device_name, req.params.control_group, req.params.control);
    
    device_tools.sendHarmonyCommand(modules, selectedControl.formattedCommand);
    //modules.harmony.hub.send('holdAction', 'action=' + selectedControl.formattedCommand + ':status=press');
    res.sendStatus(200);
});

//------------------Plex API

app.route('/plex/webhook').post(upload.single('thumb'), (req, res, next) => {
    var payload = JSON.parse(req.body.payload);
    console.log(payload);

    activities.filter((eachActivity) => {
        return eachActivity.triggers.plex !== undefined;
    }).map((plexActivity) => {
        var triggerSpecs = plexActivity.triggers.plex;
        var eventMatch = triggerSpecs.event === undefined || triggerSpecs.event.includes(payload.event);
        var accountMatch = triggerSpecs.account === undefined || triggerSpecs.account.includes(payload.Account.title.toLowerCase());
        var playerMatch = triggerSpecs.player === undefined || triggerSpecs.player.includes(payload.Player.uuid);
        if (eventMatch && accountMatch && playerMatch) {
            device_tools.runActivity(modules, activities, devices, plexActivity.name);
        }
    });


    /*
    if (payload.event == 'media.play' && payload.Account.title == 'donaldelrod' && Player.title == 'PS4') {
        //add code here to turn off all lights in room but turn on PS4 sign
    }*/

    res.sendStatus(200);
});