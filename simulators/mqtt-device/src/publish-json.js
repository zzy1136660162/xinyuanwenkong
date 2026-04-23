const path = require("node:path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });
const mqtt = require("mqtt");

const brokerUrl = process.env.MQTT_BROKER_URL || "mqtt://127.0.0.1:1883";
const topic = process.argv[2];
const retain = process.argv.includes("--retain") || process.env.RETAIN_MESSAGES === "true" || process.env.MQTT_RETAIN_REPORTS === "true";
const payloadText = process.argv.slice(3).filter((arg) => arg !== "--retain").join(" ");

if (!topic || !payloadText) {
  console.log(`
Usage:
  npm run publish-json -- <topic> '<json>' [--retain]

Example:
  npm run publish-json -- DN4G35AJ0123/dn/c2s '{"equipNo":"DN4G35AJ0123","dev":{"devTemp1":56.5,"devHumi1":36}}'
  npm run publish-json -- DN4G35AJ0123/dn/c2s '{"equipNo":"DN4G35AJ0123","dev":{"devTemp1":56.5}}' --retain
`);
  process.exit(1);
}

let payload;
try {
  payload = JSON.parse(payloadText);
} catch (error) {
  console.error(`Invalid JSON: ${error.message}`);
  process.exit(1);
}

const client = mqtt.connect(brokerUrl, {
  clientId: `xywk_json_pub_${process.pid}_${Date.now()}`,
  clean: true,
  reconnectPeriod: 0,
  connectTimeout: 5000
});

const timeout = setTimeout(() => {
  console.error("timeout connecting to MQTT broker");
  client.end(true, () => process.exit(2));
}, 8000);

client.on("connect", () => {
  const text = JSON.stringify(payload);
  client.publish(topic, text, { qos: 1, retain }, (error) => {
    clearTimeout(timeout);

    if (error) {
      console.error(error.message);
      client.end(true, () => process.exit(1));
      return;
    }

    console.log(`published ${topic} retain=${retain}`);
    console.log(JSON.stringify(payload, null, 2));
    client.end(true, () => process.exit(0));
  });
});

client.on("error", (error) => {
  clearTimeout(timeout);
  console.error(error.message);
  client.end(true, () => process.exit(1));
});
