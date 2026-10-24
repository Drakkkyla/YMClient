# stdin/stdout <-> Apple Mobile Device Service (127.0.0.1:27015), used by socat in WSL.
import socket, sys, threading
s = socket.create_connection(("127.0.0.1", 27015))
inp = getattr(sys.stdin.buffer, "raw", sys.stdin.buffer)
out = getattr(sys.stdout.buffer, "raw", sys.stdout.buffer)
def up():
    while True:
        d = inp.read(65536)
        if not d: break
        s.sendall(d)
    try: s.shutdown(socket.SHUT_WR)
    except OSError: pass
threading.Thread(target=up, daemon=True).start()
while True:
    d = s.recv(65536)
    if not d: break
    out.write(d)
