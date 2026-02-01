#!/usr/bin/env python3
import time
import psutil
import os

# 使用临时文件存储上一次的流量数据，避免 time.sleep(1) 阻塞 Waybar
CACHE_FILE = "/tmp/waybar_net_speed_cache"

def get_net_io():
    net_io = psutil.net_io_counters()
    return net_io.bytes_recv, time.time()

def format_speed(speed):
    if speed < 1024:
        return f"{speed:.0f} B/s"
    elif speed < 1024 * 1024:
        return f"{speed / 1024:.1f} KB/s"
    else:
        return f"{speed / 1024 / 1024:.1f} MB/s"

def main():
    current_bytes, current_time = get_net_io()
    
    if os.path.exists(CACHE_FILE):
        with open(CACHE_FILE, "r") as f:
            try:
                last_bytes, last_time = map(float, f.read().split())
                duration = current_time - last_time
                if duration > 0:
                    speed = (current_bytes - last_bytes) / duration
                    print(f"󰱓  {format_speed(max(0, speed))}")
                else:
                    print("󰱓  0.0 B/s")
            except:
                print("󰱓  0.0 B/s")
    else:
        print("󰱓  0.0 B/s")

    with open(CACHE_FILE, "w") as f:
        f.write(f"{current_bytes} {current_time}")

if __name__ == "__main__":
    main()