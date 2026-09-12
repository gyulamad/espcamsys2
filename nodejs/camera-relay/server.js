const express = require('express');
const { EventEmitter } = require('events');
const config = require('./config'); // gitignored — see example.config.js

const app = express();
const PORT = process.env.PORT || config.port;
const API_KEY = process.env.CAM_KEY || config.camKey; // must match API_KEY in each camera's sketch

// Raw binary body for camera uploads (JPEG bytes, not JSON/form)
app.use('/upload/:id', express.raw({ type: '*/*', limit: '2mb' }));

const cameras = {}; // id -> { frame, emitter, lastSeen }

function getCamera(id) {
  if (!cameras[id]) {
    cameras[id] = { frame: null, emitter: new EventEmitter(), lastSeen: null };
    cameras[id].emitter.setMaxListeners(50); // allow many simultaneous viewers
  }
  return cameras[id];
}

// Camera pushes a frame here
app.post('/upload/:id', (req, res) => {
  if (req.query.key !== API_KEY) return res.sendStatus(403);
  const cam = getCamera(req.params.id);
  cam.frame = req.body;
  cam.lastSeen = new Date();
  cam.emitter.emit('frame', cam.frame); // push instantly to any watching browsers
  res.sendStatus(200);
});

// Browser opens this to watch the live stream (works as an <img src="...">)
app.get('/stream/:id', (req, res) => {
  const cam = getCamera(req.params.id);
  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
    'Cache-Control': 'no-cache',
    Connection: 'close',
  });

  const onFrame = (frame) => {
    res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
    res.write(frame);
    res.write('\r\n');
  };

  if (cam.frame) onFrame(cam.frame); // show last known frame immediately on connect
  cam.emitter.on('frame', onFrame);

  req.on('close', () => cam.emitter.off('frame', onFrame));
});

// Single still image, handy for thumbnails/testing
app.get('/snapshot/:id', (req, res) => {
  const cam = cameras[req.params.id];
  if (!cam || !cam.frame) return res.sendStatus(404);
  res.set('Content-Type', 'image/jpeg');
  res.send(cam.frame);
});

// Quick health check across all cameras
app.get('/status', (req, res) => {
  const out = {};
  for (const id in cameras) out[id] = { lastSeen: cameras[id].lastSeen };
  res.json(out);
});

app.listen(PORT, () => console.log(`Camera relay listening on :${PORT}`));
