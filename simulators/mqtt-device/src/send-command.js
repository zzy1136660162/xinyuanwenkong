const path = require("node:path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });
const mqtt = require("mqtt");

const config = {
  brokerUrl: process.env.MQTT_BROKER_URL || "mqtt://127.0.0.1:1883",
  deviceSn: Object.prototype.hasOwnProperty.call(process.env, "DEVICE_SN")
    ? process.env.DEVICE_SN
    : (process.env.DEVICE_ID || "DN4G35AJ0123"),
  imei: process.env.DEVICE_IMEI || "864865082580458",
  devAddr: Number(process.env.DEV_ADDR || 1),
  username: process.env.MQTT_USERNAME || undefined,
  password: process.env.MQTT_PASSWORD || undefined
};

const command = buildCommand(process.argv.slice(2));

if (!command) {
  printUsage();
  process.exit(1);
}

const client = mqtt.connect(config.brokerUrl, {
  clientId: `xywk_protocol_sender_${process.pid}_${Date.now()}`,
  username: config.username,
  password: config.password,
  clean: true,
  reconnectPeriod: 0,
  connectTimeout: 5000
});

let finished = false;
let publishStarted = false;

const timeout = setTimeout(() => {
  const target = command.waitTopic || command.topic;
  finish(2, `timeout waiting MQTT response: ${target}`);
}, 12000);

client.on("connect", () => {
  if (finished) {
    return;
  }

  if (command.waitTopic) {
    client.subscribe(command.waitTopic, { qos: 1 }, (error) => {
      if (finished) {
        return;
      }

      if (error) {
        finish(1, `subscribe failed: ${command.waitTopic} ${error.message}`);
        return;
      }

      publishCommand();
    });
    return;
  }

  publishCommand();
});

client.on("message", (topic, payload, packet) => {
  if (finished) {
    return;
  }

  if (topic !== command.waitTopic) {
    return;
  }

  if (!publishStarted || packet.retain) {
    return;
  }

  let message;
  try {
    message = JSON.parse(payload.toString("utf8"));
  } catch {
    return;
  }

  if (command.responseMatcher && !command.responseMatcher(message, packet)) {
    return;
  }

  clearTimeout(timeout);
  console.log(`received ${topic}`);
  console.log(JSON.stringify(message, null, 2));
  finish(0);
});

client.on("error", (error) => {
  finish(1, `mqtt error: ${error.message}`);
});

function publishCommand() {
  if (finished) {
    return;
  }

  if (client.disconnecting || !client.connected) {
    finish(1, "publish failed: mqtt client is not connected");
    return;
  }

  publishStarted = true;
  client.publish(command.topic, JSON.stringify(command.payload), { qos: 1 }, (error) => {
    if (finished) {
      return;
    }

    if (error) {
      finish(1, `publish failed: ${error.message}`);
      return;
    }

    console.log(`published ${command.topic}`);
    console.log(JSON.stringify(command.payload, null, 2));

    if (!command.waitTopic) {
      finish(0);
    }
  });
}

function finish(code, message) {
  if (finished) {
    return;
  }

  finished = true;
  clearTimeout(timeout);

  if (message) {
    if (code === 0) {
      console.log(message);
    } else {
      console.error(message);
    }
  }

  if (client.disconnecting || client.disconnected) {
    process.exit(code);
    return;
  }

  client.end(true, () => process.exit(code));
}

function buildCommand(args) {
  const [type, ...values] = args;

  if (!type) {
    return null;
  }

  if (type === "set_sn") {
    const sn = values[0] || config.deviceSn;
    return {
      topic: `${config.imei}/setsn`,
      waitTopic: `${config.imei}/snSuccess`,
      responseMatcher: (message) => message.sn === sn,
      payload: {
        gwIMEI: config.imei,
        sn
      }
    };
  }

  if (type === "cloud_lock") {
    const cloudLock = toOnOff(values[0]);
    return {
      topic: `${config.deviceSn}/dh/s2c/cloudLock`,
      waitTopic: `${config.deviceSn}/dn/c2s`,
      responseMatcher: (message) => message.equipNo === config.deviceSn && Number(message.cloudLock) === cloudLock,
      payload: {
        equipNo: config.deviceSn,
        cloudLock
      }
    };
  }

  if (type === "ret") {
    return {
      topic: `${config.deviceSn}/dn/s2c/ret`,
      payload: {
        equipNo: config.deviceSn,
        snno: nextCommandSequence(),
        result: Number(values[0] || 0),
        message: values.slice(1).join(" ") || "ok"
      }
    };
  }

  let payload;
  try {
    payload = buildControlPayload(type, values);
  } catch {
    try {
      payload = JSON.parse(args.join(" "));
    } catch {
      return null;
    }
  }

  return {
    topic: `${config.deviceSn}/dn/s2c/ctl`,
    waitTopic: `${config.deviceSn}/dn/c2s`,
    responseMatcher: buildControlResponseMatcher(payload),
    payload
  };
}

function buildControlResponseMatcher(payload) {
  const expected = [];

  collectExpectedFields(expected, "dev", payload.dev, ["devOnOff", "devRunMode", "devTempset", "devchildLock"]);
  collectExpectedFields(expected, "sche", payload.sche, ["ri-pro", "mon-pro", "tue-pro", "wed-pro", "thur-pro", "fri-pro", "sat-pro", "sun-pro"]);
  collectExpectedFields(expected, "back", payload.back, [
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

  if (payload.sim && Object.prototype.hasOwnProperty.call(payload.sim, "devErr")) {
    expected.push(["dev", "devErr", normalizeFault(payload.sim.devErr)]);
  }

  const expectsFullState = Boolean(
    Number(payload.dataArea && payload.dataArea.askdataArea) === 1 ||
      Number(payload.gateway && payload.gateway.askgateway) === 1 ||
      Number(payload.dev && payload.dev.askdev) === 1 ||
      Number(payload.sche && payload.sche.asksche) === 1 ||
      Number(payload.back && payload.back.askback) === 1
  );

  return (message) => {
    if (message.equipNo !== config.deviceSn) {
      return false;
    }

    if (message.reason === "control_failed") {
      return true;
    }

    if (expected.length > 0) {
      return expected.every(([group, key, value]) => {
        return message[group] && valuesEqual(message[group][key], value);
      });
    }

    if (expectsFullState) {
      return Boolean(message.dataArea && message.gateway && message.dev);
    }

    return ["command_result", "command_request", "command_no_change"].includes(message.reason);
  };
}

function collectExpectedFields(expected, group, input, keys) {
  if (!input) {
    return;
  }

  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      expected.push([group, key, input[key]]);
    }
  }
}

function valuesEqual(actual, expected) {
  if (typeof expected === "number") {
    return Number(actual) === expected;
  }

  return actual === expected;
}

function buildControlPayload(type, values) {
  const payload = basePayload();

  switch (type) {
    case "power_on":
      payload.dev = { devOnOff: 1 };
      return payload;
    case "power_off":
      payload.dev = { devOnOff: 0 };
      return payload;
    case "set_power":
      payload.dev = { devOnOff: toOnOff(values[0]) };
      return payload;
    case "set_target_temp":
      payload.dev = { devTempset: Number(values[0]) };
      return payload;
    case "set_mode":
      payload.dev = { devRunMode: normalizeRunMode(values[0]) };
      return payload;
    case "set_child_lock":
      payload.dev = { devchildLock: toOnOff(values[0]) };
      return payload;
    case "request_full_state":
      payload.dataArea = { askdataArea: 1 };
      payload.gateway = { askgateway: 1 };
      payload.dev = { askdev: 1 };
      payload.sche = { asksche: 1 };
      payload.back = { askback: 1 };
      return payload;
    case "simulate_fault":
      payload.sim = { devErr: normalizeFault(values[0] || 1) };
      return payload;
    case "clear_fault":
      payload.sim = { devErr: 0 };
      return payload;
    case "set_schedule":
      payload.sche = { [normalizeScheduleKey(values[0])]: values.slice(1).join(" ") };
      return payload;
    case "set_back_param":
      payload.back = { [values[0]]: parseValue(values.slice(1).join(" ")) };
      return payload;
    default:
      throw new Error(`unsupported command: ${type}`);
  }
}

function basePayload() {
  return {
    snno: nextCommandSequence(),
    equipNo: config.deviceSn,
    devAddr: config.devAddr,
    timestamp: Date.now(),
    dataArea: {
      cmdType: 1,
      type: 5
    }
  };
}

function nextCommandSequence() {
  return Math.floor(Date.now() / 1000) % 999 || 1;
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
    throw new Error("invalid mode");
  }
  return modes[text];
}

function normalizeScheduleKey(value) {
  const text = String(value).toLowerCase();
  const keys = {
    day: "ri-pro",
    ri: "ri-pro",
    "ri-pro": "ri-pro",
    mon: "mon-pro",
    "mon-pro": "mon-pro",
    tue: "tue-pro",
    "tue-pro": "tue-pro",
    wed: "wed-pro",
    "wed-pro": "wed-pro",
    thur: "thur-pro",
    thu: "thur-pro",
    "thur-pro": "thur-pro",
    fri: "fri-pro",
    "fri-pro": "fri-pro",
    sat: "sat-pro",
    "sat-pro": "sat-pro",
    sun: "sun-pro",
    "sun-pro": "sun-pro"
  };

  if (!Object.prototype.hasOwnProperty.call(keys, text)) {
    throw new Error("invalid schedule key");
  }
  return keys[text];
}

function normalizeFault(value) {
  if (typeof value === "string" && /^e\d+$/i.test(value)) {
    return Number(value.slice(1));
  }
  return Number(value);
}

function toOnOff(value) {
  if (value === "on" || value === "1" || value === 1 || value === true) {
    return 1;
  }
  if (value === "off" || value === "0" || value === 0 || value === false) {
    return 0;
  }
  throw new Error("value must be on/off or 1/0");
}

function parseValue(value) {
  const trimmed = String(value).trim();
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (trimmed !== "" && Number.isFinite(Number(trimmed))) {
    return Number(trimmed);
  }
  return trimmed;
}

function printUsage() {
  console.log(`
Usage:
  npm run command -- power_on
  npm run command -- power_off
  npm run command -- set_power on
  npm run command -- set_target_temp 22
  npm run command -- set_mode comfort
  npm run command -- set_mode day_plan
  npm run command -- set_mode week_plan
  npm run command -- set_mode anti_freeze
  npm run command -- set_child_lock on
  npm run command -- request_full_state
  npm run command -- simulate_fault E02
  npm run command -- clear_fault
  npm run command -- cloud_lock on
  npm run command -- set_sn DN4G35AJ0123
  npm run command -- set_schedule day "10,16,20,32,10,48,10,48,10,48,10,48,10,48,10"
  npm run command -- set_back_param TempAdj 1.2

Custom protocol JSON:
  npm run command -- '{"equipNo":"DN4G35AJ0123","dev":{"devTempset":22}}'
`);
}
