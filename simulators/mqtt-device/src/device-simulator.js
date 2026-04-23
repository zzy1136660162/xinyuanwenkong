const path = require("node:path");
const readline = require("node:readline");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });
const mqtt = require("mqtt");

const config = {
  brokerUrl: process.env.MQTT_BROKER_URL || "mqtt://127.0.0.1:1883",
  deviceSn: Object.prototype.hasOwnProperty.call(process.env, "DEVICE_SN")
    ? process.env.DEVICE_SN
    : (process.env.DEVICE_ID || "DN4G35AJ0123"),
  imei: process.env.DEVICE_IMEI || "864865082580458",
  iccid: process.env.DEVICE_ICCID || "89860479102590023261",
  devAddr: Number(process.env.DEV_ADDR || 1),
  username: process.env.MQTT_USERNAME || undefined,
  password: process.env.MQTT_PASSWORD || undefined,
  provisionOnStart: process.env.PROVISION_ON_START === "true",
  retainReports: process.env.RETAIN_MESSAGES === "true" || process.env.MQTT_RETAIN_REPORTS === "true",
  fullReportIntervalMs: Number(process.env.FULL_REPORT_INTERVAL_MS || 30 * 60 * 1000),
  deltaReportIntervalMs: Number(process.env.DELTA_REPORT_INTERVAL_MS || 5000)
};

let sequence = 0;

const state = {
  DayTime: {
    ask3: 0,
    Day: getProtocolDay(),
    Time: getProtocolMinute()
  },
  dataArea: {
    askdataArea: 0,
    cmdType: 0,
    type: 5,
    type2: 4,
    DeviceMode: 1,
    gwCSQ: 78,
    gwDevCnt: 1,
    gwDataInterval: Math.round(config.fullReportIntervalMs / 1000),
    hardVersion: "1.01",
    gwVersion: "1.21",
    mcuVersion: "1.01",
    gwAddr: 1,
    gwChannel: 1,
    gwLoraPower: 10,
    gwIMEI: config.imei,
    gwICCID: config.iccid,
    gwmisisdn: ""
  },
  gateway: {
    askgateway: 0,
    devWtTemp: 50,
    dev8LOnline: 1,
    dev8LHeating: 0
  },
  dev: {
    askdev: 0,
    devOnline: 1,
    devRSSI: 78,
    devOnOff: 0,
    devRunMode: 1,
    devTempset: 18,
    devTemp1: 26.9,
    devHumi1: 36,
    devHeating: 0,
    devchildLock: 0,
    devErr: 0,
    devType: 0,
    devWtEachTemp: 50
  },
  sche: {
    asksche: 0,
    "ri-pro": "10,16,20,32,10,48,10,48,10,48,10,48,10,48,10",
    "mon-pro": "10,16,20,32,10,48,10,48,10,48,10,48,10,48,10",
    "tue-pro": "10,16,20,32,10,48,10,48,10,48,10,48,10,48,10",
    "wed-pro": "10,16,20,32,10,48,10,48,10,48,10,48,10,48,10",
    "thur-pro": "10,16,20,32,10,48,10,48,10,48,10,48,10,48,10",
    "fri-pro": "10,16,20,32,10,48,10,48,10,48,10,48,10,48,10",
    "sat-pro": "10,16,20,32,10,48,10,48,10,48,10,48,10,48,10",
    "sun-pro": "10,16,20,32,10,48,10,48,10,48,10,48,10,48,10"
  },
  back: {
    askback: 0,
    TempAdj: 0,
    HumAdj: 0,
    TempsetTop: 60,
    Tolr: 0.5,
    Antifreeze: 5,
    RFAntifreeze: 5,
    "Anti-blocking protection": 1,
    wtTempMax: 80,
    wtTempMin: 30,
    wtTempDef: 50,
    wtTempSen: 1.0,
    sugMode: 0,
    backVersion: 101
  },
  ota: {
    ota4G: "",
    otaMCU1: "",
    otaMCU2: ""
  },
  cloudLock: 0
};

let topics = buildTopics();

const client = mqtt.connect(config.brokerUrl, {
  clientId: `${config.deviceSn || config.imei}_sim_${process.pid}`,
  username: config.username,
  password: config.password,
  clean: true,
  reconnectPeriod: 3000,
  keepalive: 60
});

client.on("connect", () => {
  log(`connected to ${config.brokerUrl}`);
  subscribeBaseTopics();

  if (config.provisionOnStart || !config.deviceSn) {
    publishGetSn();
    return;
  }

  subscribeDeviceTopics();
  publishFullState("startup");
  printHelp();
});

client.on("reconnect", () => log("reconnecting..."));
client.on("error", (error) => log(`mqtt error: ${error.message}`));

client.on("message", (topic, payload) => {
  let message;
  try {
    message = JSON.parse(payload.toString("utf8"));
  } catch {
    log(`invalid json from ${topic}: ${payload.toString("utf8")}`);
    return;
  }

  if (topic === topics.setSn) {
    handleSetSn(message);
    return;
  }

  if (topic === topics.controlDown) {
    handleControl(message);
    return;
  }

  if (topic === topics.platformRet) {
    log(`platform ret ${topic}: ${JSON.stringify(message)}`);
    return;
  }

  if (topic === topics.cloudLock) {
    handleCloudLock(message);
  }
});

setInterval(() => {
  if (config.deviceSn) {
    publishFullState("periodic_full");
  }
}, config.fullReportIntervalMs);

setInterval(() => {
  if (config.deviceSn) {
    simulatePropertyChanges();
  }
}, config.deltaReportIntervalMs);

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

let rl;
if (process.stdin.isTTY) {
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "device-sim> "
  });

  rl.on("line", (line) => {
    handleCli(line.trim());
    rl.prompt();
  });
}

function buildTopics() {
  return {
    reportUp: config.deviceSn ? `${config.deviceSn}/dn/c2s` : null,
    controlDown: config.deviceSn ? `${config.deviceSn}/dn/s2c/ctl` : null,
    platformRet: config.deviceSn ? `${config.deviceSn}/dn/s2c/ret` : null,
    cloudLock: config.deviceSn ? `${config.deviceSn}/dh/s2c/cloudLock` : null,
    getSn: `${config.imei}/getsn`,
    setSn: `${config.imei}/setsn`,
    snSuccess: `${config.imei}/snSuccess`
  };
}

function subscribeBaseTopics() {
  client.subscribe(topics.setSn, { qos: 1 }, (error) => {
    if (error) {
      log(`subscribe failed: ${topics.setSn} ${error.message}`);
      return;
    }
    log(`subscribed: ${topics.setSn}`);
  });
}

function subscribeDeviceTopics() {
  topics = buildTopics();
  const topicList = [topics.controlDown, topics.platformRet, topics.cloudLock].filter(Boolean);
  if (topicList.length === 0) {
    return;
  }

  client.subscribe(topicList, { qos: 1 }, (error) => {
    if (error) {
      log(`subscribe failed: ${error.message}`);
      return;
    }
    log(`subscribed: ${topicList.join(", ")}`);
  });
}

function handleSetSn(message) {
  const sn = message.sn || message.equipNo;
  const imei = message.gwIMEI || message.imei || config.imei;
  const success = imei === config.imei && Boolean(sn);

  if (success) {
    config.deviceSn = sn;
    topics = buildTopics();
    subscribeDeviceTopics();
  }

  publish(topics.snSuccess, {
    imei,
    sn: sn || "",
    isSuccess: success ? 0 : 1
  }, 1);

  if (success) {
    log(`SN set success: ${config.deviceSn}`);
    publishFullState("sn_success");
  }
}

function publishGetSn() {
  publish(topics.getSn, {
    eo: config.imei,
    ep: config.imei,
    ec: 5,
    ed: "4G",
    gi: 0
  }, 1);
}

function handleCloudLock(message) {
  state.cloudLock = Number(message.cloudLock || 0);
  log(`cloudLock updated: ${state.cloudLock}`);
  publishFullState("cloud_lock");
}

function handleControl(command) {
  if (command.equipNo && command.equipNo !== config.deviceSn) {
    log(`ignore command for another equipNo: ${command.equipNo}`);
    return;
  }

  const changed = {};
  let requestFull = false;

  try {
    if (command.dataArea) {
      requestFull = requestFull || Number(command.dataArea.askdataArea) === 1;
      applyWritableFields("dataArea", command.dataArea, changed, ["askdataArea", "gwDevCnt", "gwDataInterval", "gwAddr", "gwChannel", "gwLoraPower"]);
    }

    if (command.gateway) {
      requestFull = requestFull || Number(command.gateway.askgateway) === 1;
      applyWritableFields("gateway", command.gateway, changed, ["askgateway"]);
    }

    if (command.dev) {
      requestFull = requestFull || Number(command.dev.askdev) === 1;
      applyDevCommand(command.dev, changed);
    }

    if (command.sche) {
      requestFull = requestFull || Number(command.sche.asksche) === 1;
      applyWritableFields("sche", command.sche, changed, ["asksche", "ri-pro", "mon-pro", "tue-pro", "wed-pro", "thur-pro", "fri-pro", "sat-pro", "sun-pro"]);
    }

    if (command.back) {
      requestFull = requestFull || Number(command.back.askback) === 1;
      applyWritableFields("back", command.back, changed, [
        "askback",
        "TempAdj",
        "HumAdj",
        "TempsetTop",
        "Tolr",
        "Antifreeze",
        "RFAntifreeze",
        "Anti-blocking protection",
        "wtTempMax",
        "wtTempMin",
        "wtTempDef",
        "wtTempSen",
        "sugMode"
      ]);
    }

    if (command.ota) {
      applyWritableFields("ota", command.ota, changed, ["ota4G", "otaMCU1", "otaMCU2"]);
    }

    if (command.sim) {
      applySimulatorFields(command.sim, changed);
    }

    refreshDerivedFields(changed);
  } catch (error) {
    log(`control failed: ${error.message}`);
    publishDeviceReport({ dataArea: { cmdType: -1 }, dev: { devErr: state.dev.devErr } }, "control_failed");
    return;
  }

  if (requestFull) {
    publishFullState("command_request");
    return;
  }

  if (Object.keys(changed).length > 0) {
    publishDeviceReport(changed, "command_result");
  } else {
    publishFullState("command_no_change");
  }
}

function applyDevCommand(input, changed) {
  if (Object.prototype.hasOwnProperty.call(input, "askdev")) {
    setField("dev", "askdev", Number(input.askdev), changed);
  }

  if (Object.prototype.hasOwnProperty.call(input, "devOnOff")) {
    const value = Number(input.devOnOff);
    requireIn(value, [0, 1], "devOnOff");
    setField("dev", "devOnOff", value, changed);
  }

  if (Object.prototype.hasOwnProperty.call(input, "devRunMode")) {
    const value = Number(input.devRunMode);
    requireRange(value, 0, 3, "devRunMode");
    setField("dev", "devRunMode", value, changed);
  }

  if (Object.prototype.hasOwnProperty.call(input, "devTempset")) {
    const value = Number(input.devTempset);
    requireRange(value, 2, 85, "devTempset");
    setField("dev", "devTempset", value, changed);
  }

  if (Object.prototype.hasOwnProperty.call(input, "devchildLock")) {
    const value = Number(input.devchildLock);
    requireIn(value, [0, 1], "devchildLock");
    setField("dev", "devchildLock", value, changed);
  }
}

function applySimulatorFields(input, changed) {
  if (Object.prototype.hasOwnProperty.call(input, "devErr")) {
    const value = normalizeFault(input.devErr);
    setField("dev", "devErr", value, changed);
  }

  if (Object.prototype.hasOwnProperty.call(input, "devTemp1")) {
    const value = Number(input.devTemp1);
    requireRange(value, -30, 100, "devTemp1");
    setField("dev", "devTemp1", round(value), changed);
  }

  if (Object.prototype.hasOwnProperty.call(input, "devHumi1")) {
    const value = Number(input.devHumi1);
    requireRange(value, 0, 99, "devHumi1");
    setField("dev", "devHumi1", Math.round(value), changed);
  }
}

function applyWritableFields(group, input, changed, allowedKeys) {
  for (const key of allowedKeys) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      setField(group, key, input[key], changed);
    }
  }
}

function setField(group, key, value, changed) {
  if (state[group][key] === value) {
    return;
  }

  state[group][key] = value;
  if (!changed[group]) {
    changed[group] = {};
  }
  changed[group][key] = value;
}

function setPower(power) {
  const value = power === "on" || power === "1" ? 1 : power === "off" || power === "0" ? 0 : NaN;
  requireIn(value, [0, 1], "power");
  const changed = {};
  setField("dev", "devOnOff", value, changed);
  refreshDerivedFields(changed);
  return changed;
}

function setTargetTemp(value) {
  const temp = Number(value);
  requireRange(temp, 2, 85, "devTempset");
  const changed = {};
  setField("dev", "devTempset", Math.round(temp), changed);
  refreshDerivedFields(changed);
  return changed;
}

function setMode(value) {
  const mode = normalizeRunMode(value);
  const changed = {};
  setField("dev", "devRunMode", mode, changed);
  refreshDerivedFields(changed);
  return changed;
}

function setChildLock(value) {
  const lock = value === "on" || value === "1" ? 1 : value === "off" || value === "0" ? 0 : NaN;
  requireIn(lock, [0, 1], "devchildLock");
  const changed = {};
  setField("dev", "devchildLock", lock, changed);
  return changed;
}

function setFault(value) {
  const changed = {};
  setField("dev", "devErr", normalizeFault(value || 1), changed);
  refreshDerivedFields(changed);
  return changed;
}

function clearFault() {
  const changed = {};
  setField("dev", "devErr", 0, changed);
  refreshDerivedFields(changed);
  return changed;
}

function simulatePropertyChanges() {
  const changed = {};
  const dev = state.dev;

  if (dev.devOnOff === 1 && dev.devErr === 0) {
    const diff = dev.devTempset - dev.devTemp1;
    if (Math.abs(diff) > 0.2) {
      setField("dev", "devTemp1", round(dev.devTemp1 + Math.sign(diff) * Math.min(Math.abs(diff), 0.8)), changed);
    }
  } else if (dev.devTemp1 > 5) {
    setField("dev", "devTemp1", round(dev.devTemp1 - 0.2), changed);
  }

  setField("dev", "devHumi1", Math.round(clamp(dev.devHumi1 + randomBetween(-1, 1), 0, 99)), changed);
  setField("dev", "devRSSI", Math.round(clamp(dev.devRSSI + randomBetween(-1, 1), 0, 99)), changed);
  setField("dataArea", "gwCSQ", Math.round(clamp(state.dataArea.gwCSQ + randomBetween(-1, 1), 0, 99)), changed);

  refreshDerivedFields(changed);

  if (Object.keys(changed).length > 0) {
    publishDeviceReport(changed, "property_change");
  }
}

function refreshDerivedFields(changed) {
  const dev = state.dev;
  const heating = dev.devOnOff === 1 && dev.devErr === 0 && dev.devTemp1 < dev.devTempset - 0.3 ? 1 : 0;
  setField("dev", "devHeating", heating, changed);
  setField("gateway", "dev8LOnline", 1, changed);
  setField("gateway", "dev8LHeating", heating ? 1 : 0, changed);
  setField("gateway", "devWtTemp", clamp(Math.round(45 + (dev.devTempset - 18) * 1.2), 30, 80), changed);
  setField("dev", "devWtEachTemp", state.gateway.devWtTemp, changed);
}

function publishFullState(reason) {
  publishDeviceReport({
    DayTime: {
      ask3: 0,
      Day: getProtocolDay(),
      Time: getProtocolMinute()
    },
    dataArea: state.dataArea,
    gateway: state.gateway,
    dev: state.dev,
    sche: state.sche,
    back: state.back,
    ota: state.ota,
    cloudLock: state.cloudLock
  }, reason);
}

function publishDeviceReport(groups, reason) {
  if (!config.deviceSn || !topics.reportUp) {
    log("skip report: device SN is empty");
    return;
  }

  const payload = {
    snno: nextSequence(),
    equipNo: config.deviceSn,
    devAddr: config.devAddr,
    timestamp: Date.now(),
    reason,
    ...clone(groups)
  };

  publish(topics.reportUp, payload, 1, config.retainReports);
}

function publish(topic, payload, qos, retain = false) {
  const text = JSON.stringify(payload);
  client.publish(topic, text, { qos, retain }, (error) => {
    if (error) {
      log(`publish failed: ${topic} ${error.message}`);
      return;
    }
    log(`publish ${topic} retain=${retain}: ${text}`);
  });
}

function handleCli(line) {
  const [command, ...args] = line.split(/\s+/).filter(Boolean);

  if (!command) {
    return;
  }

  try {
    switch (command) {
      case "help":
        printHelp();
        break;
      case "topics":
        console.log(JSON.stringify(topics, null, 2));
        break;
      case "state":
        console.log(JSON.stringify(buildCurrentState(), null, 2));
        break;
      case "full":
        publishFullState("manual");
        break;
      case "getsn":
        publishGetSn();
        break;
      case "power":
        publishDeviceReport(setPower(args[0]), "manual");
        break;
      case "temp":
        publishDeviceReport(setTargetTemp(args[0]), "manual");
        break;
      case "mode":
        publishDeviceReport(setMode(args[0]), "manual");
        break;
      case "lock":
        publishDeviceReport(setChildLock(args[0]), "manual");
        break;
      case "fault":
        publishDeviceReport(setFault(args[0] || 1), "manual");
        break;
      case "clear":
        publishDeviceReport(clearFault(), "manual");
        break;
      case "exit":
      case "quit":
        shutdown();
        break;
      default:
        log(`unknown command: ${command}`);
        printHelp();
    }
  } catch (error) {
    log(`command failed: ${error.message}`);
  }
}

function printHelp() {
  console.log(`
Protocol topics:
  report up      ${topics.reportUp || "(SN empty)"}
  control down   ${topics.controlDown || "(SN empty)"}
  platform ret   ${topics.platformRet || "(SN empty)"}
  cloud lock     ${topics.cloudLock || "(SN empty)"}
  get SN         ${topics.getSn}
  set SN         ${topics.setSn}
  SN success     ${topics.snSuccess}

Commands:
  help                 show help
  topics               print protocol topics
  state                print current protocol state
  full                 publish full state to SN/dn/c2s
  getsn                publish IMEI/getsn
  power on|off         update dev.devOnOff and publish c2s
  temp 22              update dev.devTempset and publish c2s
  mode comfort         day_plan|comfort|week_plan|anti_freeze
  lock on|off          update dev.devchildLock and publish c2s
  fault E02            update dev.devErr and publish c2s
  clear                clear dev.devErr and publish c2s
  exit                 stop simulator
`);
  if (rl) {
    rl.prompt();
  }
}

function shutdown() {
  if (config.deviceSn) {
    const changed = {};
    setField("dev", "devOnline", 0, changed);
    publishDeviceReport(changed, "simulator_stopped");
  }

  setTimeout(() => {
    client.end(true, () => process.exit(0));
  }, 300);
}

function buildCurrentState() {
  return {
    snno: sequence,
    equipNo: config.deviceSn,
    devAddr: config.devAddr,
    ...clone(state)
  };
}

function nextSequence() {
  sequence += 1;
  if (sequence > 999) {
    sequence = 1;
  }
  return sequence;
}

function normalizeRunMode(value) {
  const text = String(value).toLowerCase();
  const modes = {
    "0": 0,
    day: 0,
    day_plan: 0,
    dayplan: 0,
    "日计划": 0,
    "1": 1,
    comfort: 1,
    comfortable: 1,
    "舒适": 1,
    "2": 2,
    week: 2,
    week_plan: 2,
    weekplan: 2,
    "周计划": 2,
    "3": 3,
    anti_freeze: 3,
    antifreeze: 3,
    freeze: 3,
    "防冻": 3
  };

  if (!Object.prototype.hasOwnProperty.call(modes, text)) {
    throw new Error("devRunMode must be 0/day_plan, 1/comfort, 2/week_plan, or 3/anti_freeze");
  }
  return modes[text];
}

function normalizeFault(value) {
  if (typeof value === "string" && /^e\d+$/i.test(value)) {
    return Number(value.slice(1));
  }

  const code = Number(value);
  if (!Number.isInteger(code) || code < 0) {
    throw new Error("devErr must be a non-negative integer or E01 style code");
  }
  return code;
}

function requireRange(value, min, max, field) {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${field} must be between ${min} and ${max}`);
  }
}

function requireIn(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw new Error(`${field} must be one of: ${allowed.join(", ")}`);
  }
}

function getProtocolDay() {
  const day = new Date().getDay();
  return day === 0 ? 7 : day;
}

function getProtocolMinute() {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}
