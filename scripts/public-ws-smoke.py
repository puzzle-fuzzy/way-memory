import base64
import json
import os
import socket
import struct

HOST = os.environ.get("WAY_MEMORY_WS_HOST", "101.35.246.159")
PORT = int(os.environ.get("WAY_MEMORY_WS_PORT", "80"))


def connect(role: str):
    sock = socket.create_connection((HOST, PORT), timeout=8)
    key = base64.b64encode(os.urandom(16)).decode()
    request = (
        f"GET /realtime?role={role}&deviceId=public-smoke HTTP/1.1\r\n"
        f"Host: {HOST}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        f"Sec-WebSocket-Key: {key}\r\n\r\n"
    ).encode()
    sock.sendall(request)
    response = b""
    while b"\r\n\r\n" not in response:
        response += sock.recv(4096)
    if b"101 Switching Protocols" not in response:
        raise RuntimeError(response.decode(errors="replace"))
    return sock


def recv_exact(sock, size: int):
    data = b""
    while len(data) < size:
        chunk = sock.recv(size - len(data))
        if not chunk:
            raise RuntimeError("websocket closed")
        data += chunk
    return data


def recv_message(sock):
    first, second = recv_exact(sock, 2)
    length = second & 0x7F
    if length == 126:
        length = struct.unpack("!H", recv_exact(sock, 2))[0]
    elif length == 127:
        length = struct.unpack("!Q", recv_exact(sock, 8))[0]
    masked = second & 0x80
    mask = recv_exact(sock, 4) if masked else b""
    payload = bytearray(recv_exact(sock, length))
    if masked:
        for index in range(length):
            payload[index] ^= mask[index % 4]
    if first & 0x0F == 0x8:
        raise RuntimeError("websocket close frame")
    return json.loads(payload.decode())


def send_message(sock, message):
    payload = json.dumps(message, separators=(",", ":")).encode()
    mask = os.urandom(4)
    masked_payload = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
    length = len(payload)
    if length < 126:
        header = bytes((0x81, 0x80 | length))
    elif length < 65536:
        header = bytes((0x81, 0xFE)) + struct.pack("!H", length)
    else:
        header = bytes((0x81, 0xFF)) + struct.pack("!Q", length)
    sock.sendall(header + mask + masked_payload)


dashboard = connect("dashboard")
device = connect("device")
send_message(device, {
    "type": "session.start",
    "deviceId": "public-smoke",
    "mode": "learning",
    "sensors": [
        {"sensorType": "android.sensor.accelerometer", "name": "Public Smoke Accelerometer", "registered": True},
        {"sensorType": "android.sensor.protected", "name": "Protected Sensor", "registered": False},
    ],
})
started = recv_message(device)
if started.get("type") != "session.started":
    raise RuntimeError(f"unexpected start: {started}")
inventory = started.get("session", {}).get("sensorInventory", [])
if len(inventory) != 2 or inventory[1].get("registered") is not False:
    raise RuntimeError(f"unexpected sensor inventory: {inventory}")
recv_message(dashboard)
session_id = started["session"]["sessionId"]
send_message(device, {
    "type": "samples",
    "sessionId": session_id,
    "samples": [{
        "deviceTimestampNs": 1,
        "sensorType": "android.sensor.linear_acceleration",
        "values": [0, 0, 0],
        "pose": {
            "deviceTimestampNs": 1,
            "xM": 0,
            "yM": 0,
            "zM": 0,
            "velocityXMps": 0,
            "velocityYMps": 0,
            "velocityZMps": 0,
            "accuracyM": 1.5,
            "confidence": 0.95,
            "source": "fused",
            "sourceFlags": ["imu", "barometer"],
            "motionMode": "stationary",
            "stationary": True,
        },
    }],
})
accepted = recv_message(device)
delta = recv_message(dashboard)
if accepted.get("type") != "samples.accepted" or delta.get("type") != "session.delta":
    raise RuntimeError(f"unexpected realtime messages: {accepted}, {delta}")
if len(delta.get("posePoints", [])) != 1 or delta.get("motionMode") != "stationary":
    raise RuntimeError(f"unexpected pose delta: {delta}")
print("Public Pose WebSocket smoke passed", {"posePoints": 1, "inventory": len(inventory), "mode": delta["motionMode"], "closure": delta["closure"]["status"]})
dashboard.close()
device.close()
