/*
	Copyright 2025 Flyinghead <flyinghead.github@gmail.com>

	This file is part of Flycast.

    Flycast is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 2 of the License, or
    (at your option) any later version.

    Flycast is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with Flycast.  If not, see <https://www.gnu.org/licenses/>.
 */
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import winston from "winston";

declare module "ws" {
  interface WebSocket {
    username: string | undefined;
    room: string;
    ip: string
    isAlive: boolean;
  }
  interface Server<T, U> {
    broadcast(msg: string, from: WebSocket): void;
    sendto(msg: string, to: string, room: string): void;
  }
}

WebSocketServer.prototype.broadcast = function(msg: string, from: WebSocket) {
  (this.clients as Set<WebSocket>).forEach((client) => {
    if (client !== from && client.readyState === WebSocket.OPEN && client.room === from.room)
      client.send(msg);
  });
};
WebSocketServer.prototype.sendto = function(msg: string, to: string, room: string) {
  (this.clients as Set<WebSocket>).forEach((client) => {
    if (client.username === to && client.room === room && client.readyState === WebSocket.OPEN)
      client.send(msg);
  });
};

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.colorize({ all: true }),
    winston.format.timestamp({ format: "MM/DD HH:mm:ss" }),
    winston.format.printf((info) => `[${info.timestamp}][${info.level}] ${info.message}`)
  ),
  transports: [
      new winston.transports.Console(),
      new winston.transports.File({ filename: process.env.LOG_FILE || "lobby.log" })
  ]
});

const server = createServer();
const rooms = [ "f355", "maxspeed", "vonot", "aerof", "aeroi" ];

const wss = new WebSocketServer({ noServer: true });

try {
  wss.on('connection', (ws: WebSocket) => {
    ws.isAlive = true;
    if (ws.room.startsWith('meet'))
    {
      logger.info(`User from ${ws.ip} meeting "${ws.room.slice(4)}"`);
      // Check if someone is already at the meeting point
      let opponent: WebSocket | undefined;
      (wss.clients as Set<WebSocket>).forEach((client) => {
        if (client !== ws && client.room === ws.room && client.username === undefined) {
          opponent = client;
        }
      });
      if (opponent !== undefined) {
        opponent.username = ws.room + "1";
        ws.username = ws.room + "2";
        opponent.send(`challenge ${ws.username}`);
        ws.send(`challenge ${opponent.username}`);
      }
    }

    ws.on('error', logger.error);
    ws.on('pong', () => ws.isAlive = true);

    ws.on('message', (rawMsg, isBinary) => {
      const msg = rawMsg.toString('utf-8');
      logger.debug("received " + msg);
      const op = msg.substring(0, msg.indexOf(' '));
      const args = msg.substring(msg.indexOf(' ') + 1);
      switch (op)
      {
        case "join":
          {
            // Build user list and verify user name is unique
            let nameTaken = false;
            let userlist = "userlist";
            (wss.clients as Set<WebSocket>).forEach((client) => {
              if (client !== ws && client.room === ws.room && client.username !== undefined) {
                if (client.username === args)
                  nameTaken = true;
                else
                  userlist += ' ' + client.username;
              }
            });
            if (nameTaken) {
              ws.close(4000, "User name already in use");
              return;
            }
            ws.username = args;
            // Send user list to new user
            ws.send(userlist);
            // Broadcast join message to other users
            wss.broadcast(msg, ws);
            logger.info(`[${ws.ip}] User ${ws.username} joined room ${ws.room}`);
            break;
          }

        case "say":
          {
            let msgout = `say ${ws.username}: ${args}`;
            wss.broadcast(msgout, ws);
            logger.info(ws.username + ": " + args);
            break;
          }

        case "challenge":
          {
            let msgout = "challenge " + ws.username;
            wss.sendto(msgout, args, ws.room);
            logger.info(`${ws.username} challenged ${args}`);
            break;
          }

        case "chalresp":
          {
            let toUser = args.substring(0, args.indexOf(' '));
            let msgout = "chalresp " +  args.substring(args.indexOf(' ') + 1);
            wss.sendto(msgout, toUser, ws.room);
            logger.info(`${ws.username} challenge response: ${args}`);
            break;
          }

        case "candidate":
          {
            let toUser = args.substring(0, args.indexOf(' '));
            let msgout = "candidate " + args.substring(args.indexOf(' ') + 1);
            wss.sendto(msgout, toUser, ws.room);
            logger.info(`${ws.username} candidate: ${args}`);
            break;
          }

        default:
          logger.error("Unknown message: " + msg);
          break;
      }
    });
    ws.on('close', (code, reason) => {
      // Send "leave" to other users
      if (ws.username !== undefined) {
        wss.broadcast("leave " + ws.username, ws);
        logger.info(`User ${ws.username} left`);
      }
      else {
        logger.info(`Anon (${ws.ip}) left`);
      }
    });
  });

  const interval = setInterval(function ping() {
    wss.clients.forEach(function each(obj) {
      const ws = obj as WebSocket;
      if (ws.isAlive === false)
        return ws.terminate();
  
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on('close', () => {
    clearInterval(interval);
    logger.info("Server connection closed");
  });
} catch (error) {
  logger.error(error);
}

server.on('upgrade', function upgrade(request, socket, head) {
  const { pathname } = new URL(request.url || "", "http://localhost");
  const proxyHeader = request.headers['x-forwarded-for'];
  let ip: string;
  if (proxyHeader) {
    if (typeof proxyHeader === 'string')
      ip = proxyHeader.split(',')[0].trim();
    else
      ip = proxyHeader[0].split(',')[0].trim();
  }
  else {
    ip = request.socket.remoteAddress ?? "?";
  }
  if (ip.startsWith("::ffff:"))
    // slice off the ipv4 subnet prefix
    ip = ip.slice(7);

  for (const room of rooms) {
    if (pathname.slice(1) === room) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        (ws as WebSocket).room = room;
        (ws as WebSocket).ip = ip;
        wss.emit('connection', ws, request);
      });
      return;
    }
  }
  if (pathname.startsWith('/meet')) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      (ws as WebSocket).room = pathname.slice(1);
      (ws as WebSocket).ip = ip;
      wss.emit('connection', ws, request);
    });
    return;
}
  logger.warn(`Invalid path ${pathname}`);
  socket.destroy();
});

server.listen(process.env.PORT || 3000);