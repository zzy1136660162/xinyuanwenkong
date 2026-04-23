# MQTT 壁挂炉设备模拟器

这个目录用于在没有真实硬件时模拟一台“壁挂炉 4G 温控器”。

当前脚本已经按用户协议 Excel 改造，不再使用旧的 `xywk/boiler/...` Topic。

## 协议 Topic

默认设备：

```text
设备SN: DN4G35AJ0123
IMEI: 864865082580458
```

默认 Topic：

```text
DN4G35AJ0123/dn/c2s              设备上报
DN4G35AJ0123/dn/s2c/ctl          平台控制指令下发
DN4G35AJ0123/dn/s2c/ret          平台回复
DN4G35AJ0123/dh/s2c/cloudLock    平台告知设备已上云锁
864865082580458/getsn            设备请求获取 SN
864865082580458/setsn            平台设置 SN
864865082580458/snSuccess        设备通知 SN 设置结果
```

## 安装依赖

```bash
cd simulators/mqtt-device
npm install
```

脚本会自动读取当前目录下的 `.env` 文件。PowerShell 中临时设置的 `$env:xxx` 会优先生效。

## 启动模拟设备

```bash
npm run device
```

开发调试时可以用 nodemon 启动，修改脚本后会自动重启：

```bash
npm run dev
```

如果要在 EMQX Dashboard 的 Retained Messages 页面看到最后一条设备上报，需要让发布端携带 MQTT retain 标志：

```bash
RETAIN_MESSAGES=true npm run device
```

Windows PowerShell：

```powershell
$env:RETAIN_MESSAGES="true"
npm run device
```

使用 nodemon 时同样可以带环境变量：

```powershell
$env:RETAIN_MESSAGES="true"
npm run dev
```

指定另一台设备：

```bash
DEVICE_SN=DN4G35AJ9999 DEVICE_IMEI=864865082580999 npm run device
```

Windows PowerShell：

```powershell
$env:DEVICE_SN="DN4G35AJ9999"
$env:DEVICE_IMEI="864865082580999"
npm run device
```

## MQTT 用户名密码

当前 `docker-compose.yml` 只配置了 EMQX Dashboard 登录账号：

```text
http://localhost:18083
admin / gesoft9919
```

这不是 MQTT 设备连接账号。当前 EMQX 没有启用 MQTT 客户端认证，所以 `.env` 里的 `MQTT_USERNAME` / `MQTT_PASSWORD` 留空也能连接；即使填了，EMQX 也不会按设备账号校验。

脚本现在会读取 `.env`，但空字符串会按未设置处理：

```text
MQTT_USERNAME=
MQTT_PASSWORD=
```

后续如果在 EMQX Dashboard 的 `Access Control` 中启用认证，并创建设备账号或接入 MySQL/Redis 认证源，这两个环境变量才会真正生效。

## 模拟器交互命令

启动后可以在终端输入：

```text
topics               查看当前 Topic
state                查看当前协议状态
full                 主动发布全量状态到 设备SN/dn/c2s
getsn                发布 IMEI/getsn
power on             开机
power off            关机
temp 22              设置 devTempset
mode comfort         舒适模式
mode day_plan        日计划
mode week_plan       周计划
mode anti_freeze     防冻
lock on              童锁开启
lock off             童锁关闭
fault E02            触发 devErr=2
clear                清除故障
exit                 退出
```

## 模拟平台下发控制

另开一个终端：

```bash
cd simulators/mqtt-device
npm run command -- power_on
npm run command -- power_off
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
```

这些命令会发布到：

```text
DN4G35AJ0123/dn/s2c/ctl
```

设备模拟器收到后，会更新状态并上报到：

```text
DN4G35AJ0123/dn/c2s
```

## 模拟 IMEI 获取 SN

设备侧发起：

```bash
PROVISION_ON_START=true DEVICE_SN= npm run device
```

或启动后输入：

```text
getsn
```

平台侧下发 SN：

```bash
npm run command -- set_sn DN4G35AJ0123
```

设备会回复：

```text
864865082580458/snSuccess
```

## 发送任意 JSON 消息

```bash
npm run publish-json -- DN4G35AJ0123/dn/c2s '{"equipNo":"DN4G35AJ0123","dev":{"devTemp1":56.5,"devHumi1":36}}'
```

发送 retained 消息：

```bash
npm run publish-json -- DN4G35AJ0123/dn/c2s '{"equipNo":"DN4G35AJ0123","dev":{"devTemp1":56.5,"devHumi1":36}}' --retain
```

Windows PowerShell 注意 JSON 引号转义：

```powershell
npm run publish-json -- DN4G35AJ0123/dn/c2s '{\"equipNo\":\"DN4G35AJ0123\",\"dev\":{\"devTemp1\":56.5,\"devHumi1\":36}}'
```

## 全量状态上报示例

```json
{
  "snno": 1,
  "equipNo": "DN4G35AJ0123",
  "devAddr": 1,
  "timestamp": 1776869000000,
  "reason": "startup",
  "DayTime": {
    "ask3": 0,
    "Day": 4,
    "Time": 920
  },
  "dataArea": {
    "askdataArea": 0,
    "cmdType": 0,
    "type": 5,
    "type2": 4,
    "gwCSQ": 78,
    "gwDevCnt": 1,
    "gwDataInterval": 1800,
    "gwVersion": "1.21",
    "gwIMEI": "864865082580458",
    "gwICCID": "89860479102590023261"
  },
  "gateway": {
    "askgateway": 0,
    "devWtTemp": 50,
    "dev8LOnline": 1,
    "dev8LHeating": 0
  },
  "dev": {
    "askdev": 0,
    "devOnline": 1,
    "devRSSI": 78,
    "devOnOff": 0,
    "devRunMode": 1,
    "devTempset": 18,
    "devTemp1": 26.9,
    "devHumi1": 36,
    "devHeating": 0,
    "devchildLock": 0,
    "devErr": 0,
    "devType": 0,
    "devWtEachTemp": 50
  }
}
```

## 控制指令示例

平台下发到：

```text
DN4G35AJ0123/dn/s2c/ctl
```

Payload：

```json
{
  "snno": 12,
  "equipNo": "DN4G35AJ0123",
  "devAddr": 1,
  "dataArea": {
    "cmdType": 1,
    "type": 5
  },
  "dev": {
    "devOnOff": 1,
    "devRunMode": 1,
    "devTempset": 22,
    "devchildLock": 0
  }
}
```

## 上报周期

默认全量上报周期是 30 分钟：

```text
FULL_REPORT_INTERVAL_MS=1800000
```

为了本地测试，也可以临时改成 30 秒：

```bash
FULL_REPORT_INTERVAL_MS=30000 npm run device
```

Windows PowerShell：

```powershell
$env:FULL_REPORT_INTERVAL_MS="30000"
npm run device
```
