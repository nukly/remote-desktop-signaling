/**
 * Public Signaling Server for Remote Desktop Application
 * 
 * Deploy this to Render.com (or any Node.js hosting) for a fixed, always-on
 * signaling server — just like AnyDesk's relay infrastructure.
 * 
 * Handles:
 * - Peer registration with unique connection IDs (xxx-xxx-xxx format)
 * - WebRTC signaling (offer/answer/ICE relay)
 * - Connection request/accept/reject flow
 * - Cross-network NAT traversal via STUN/TURN servers
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  transports: ['websocket', 'polling'],
  pingInterval: 25000,
  pingTimeout: 10000,
  maxHttpBufferSize: 1000000,
  allowEIO3: true
});

// Metered.ca TURN server API key
const METERED_API_KEY = process.env.METERED_API_KEY || '481eba005ae7ff8abeb23c33f853dccb5003';
const METERED_DOMAIN = process.env.METERED_DOMAIN || 'adin-rdp.metered.live';

// Cached ICE servers (refreshed periodically from Metered.ca)
let cachedIceServers = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];
let lastIceRefresh = 0;
const ICE_REFRESH_INTERVAL = 6 * 60 * 60 * 1000; // Refresh every 6 hours

// Fetch fresh TURN credentials from Metered.ca
async function refreshIceServers() {
  try {
    const url = `https://${METERED_DOMAIN}/api/v1/turn/credentials?apiKey=${METERED_API_KEY}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Metered API error: ${response.status}`);
    const turnServers = await response.json();
    
    // Combine Google STUN + Metered TURN servers
    cachedIceServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      ...turnServers
    ];
    lastIceRefresh = Date.now();
    console.log(`[Server] ICE servers refreshed: ${cachedIceServers.length} servers (${turnServers.length} TURN)`);
  } catch (err) {
    console.error('[Server] Failed to refresh ICE servers:', err.message);
  }
}

// Get current ICE servers (refresh if stale)
async function getIceServers() {
  if (Date.now() - lastIceRefresh > ICE_REFRESH_INTERVAL) {
    await refreshIceServers();
  }
  return cachedIceServers;
}

// Initial fetch on startup
refreshIceServers();

// CORS middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());

// Store active peers with their connection IDs
const peers = new Map();
// Store pending connection requests
const pendingConnections = new Map();

// =====================
// HTTP Endpoints
// =====================

// Health check (used by hosting platforms + client probes)
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Remote Desktop Signaling Server',
    peers: peers.size,
    uptime: Math.floor(process.uptime()),
    version: '1.0.0'
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Get server configuration (ICE servers)
app.get('/config', async (req, res) => {
  const iceServers = await getIceServers();
  res.json({ iceServers });
});

// =====================
// Helpers
// =====================

// Generate a 9-digit connection ID (similar to AnyDesk)
function generateConnectionId() {
  const id = Math.floor(100000000 + Math.random() * 900000000).toString();
  return `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6, 9)}`;
}

function findPeerByConnectionId(connectionId) {
  const normalizedId = connectionId.replace(/-/g, '');
  for (const [connId, peer] of peers) {
    if (connId.replace(/-/g, '') === normalizedId) {
      return peer;
    }
  }
  return null;
}

// =====================
// Socket.IO Events
// =====================

io.on('connection', (socket) => {
  console.log(`[Server] New connection: ${socket.id}`);

  // Register a peer and assign a connection ID
  socket.on('register', async (dataOrCallback, callbackArg) => {
    // Support both register(callback) and register({preferredId}, callback)
    let preferredId = null;
    let callback = callbackArg;
    if (typeof dataOrCallback === 'function') {
      callback = dataOrCallback;
    } else if (dataOrCallback && typeof dataOrCallback === 'object') {
      preferredId = dataOrCallback.preferredId || null;
    }

    const iceServers = await getIceServers();
    if (socket.connectionId && peers.has(socket.connectionId)) {
      if (callback) callback({ success: true, connectionId: socket.connectionId, iceServers });
      return;
    }

    let connectionId;

    // Try to use preferred ID if provided and not taken
    if (preferredId) {
      const normalizedPreferred = preferredId.replace(/-/g, '');
      const formatted = `${normalizedPreferred.slice(0, 3)}-${normalizedPreferred.slice(3, 6)}-${normalizedPreferred.slice(6, 9)}`;
      if (normalizedPreferred.length === 9 && !peers.has(formatted)) {
        connectionId = formatted;
        console.log(`[Server] Reusing preferred ID: ${connectionId}`);
      }
    }

    // Generate new ID if preferred wasn't available
    if (!connectionId) {
      connectionId = generateConnectionId();
      while (peers.has(connectionId)) {
        connectionId = generateConnectionId();
      }
    }

    peers.set(connectionId, {
      socketId: socket.id,
      socket: socket,
      status: 'available',
      connectedTo: null
    });

    socket.connectionId = connectionId;
    console.log(`[Server] Peer registered: ${connectionId} (total: ${peers.size})`);

    if (callback) callback({ success: true, connectionId, iceServers });
  });

  // Handle connection request from viewer to host
  socket.on('request-connection', ({ targetId, viewerName, password }, callback) => {
    console.log(`[Server] Connection request from ${socket.connectionId} to ${targetId}`);

    const normalizedTargetId = targetId.replace(/-/g, '');
    let targetPeer = null;
    let targetConnectionId = null;

    for (const [connId, peer] of peers) {
      if (connId.replace(/-/g, '') === normalizedTargetId) {
        targetPeer = peer;
        targetConnectionId = connId;
        break;
      }
    }

    if (!targetPeer) {
      if (callback) callback({ success: false, error: 'Peer not found or offline' });
      return;
    }

    if (targetPeer.status === 'busy') {
      if (callback) callback({ success: false, error: 'Peer is busy with another session' });
      return;
    }

    const requestId = uuidv4();
    pendingConnections.set(requestId, {
      viewerSocketId: socket.id,
      viewerConnectionId: socket.connectionId,
      hostSocketId: targetPeer.socketId,
      hostConnectionId: targetConnectionId
    });

    targetPeer.socket.emit('connection-request', {
      requestId,
      viewerId: socket.connectionId,
      viewerName: viewerName || 'Unknown',
      password: password || undefined
    });

    if (callback) callback({ success: true, requestId });
  });

  // Host accepts/rejects connection request
  socket.on('connection-response', ({ requestId, accepted }) => {
    const request = pendingConnections.get(requestId);
    if (!request) return;

    const viewerPeer = Array.from(peers.values()).find(p => p.socketId === request.viewerSocketId);
    if (!viewerPeer) {
      pendingConnections.delete(requestId);
      return;
    }

    if (accepted) {
      console.log(`[Server] Connection accepted: ${request.viewerConnectionId} -> ${request.hostConnectionId}`);
      const hostPeer = peers.get(request.hostConnectionId);
      if (hostPeer) {
        hostPeer.status = 'busy';
        hostPeer.connectedTo = request.viewerConnectionId;
      }
      const vPeer = peers.get(request.viewerConnectionId);
      if (vPeer) {
        vPeer.status = 'busy';
        vPeer.connectedTo = request.hostConnectionId;
      }
      viewerPeer.socket.emit('connection-accepted', { hostId: request.hostConnectionId });
    } else {
      viewerPeer.socket.emit('connection-rejected', { hostId: request.hostConnectionId });
    }

    pendingConnections.delete(requestId);
  });

  // Host ready signal
  socket.on('host-ready', ({ targetId }) => {
    console.log(`[Server] Host ready, notifying viewer: ${targetId}`);
    const targetPeer = findPeerByConnectionId(targetId);
    if (targetPeer) {
      targetPeer.socket.emit('host-ready', { hostId: socket.connectionId });
    }
  });

  // Camera request
  socket.on('request-camera', ({ targetId }) => {
    const targetPeer = findPeerByConnectionId(targetId);
    if (targetPeer) {
      targetPeer.socket.emit('camera-request', { requesterId: socket.connectionId });
    }
  });

  socket.on('camera-response', ({ targetId, accepted }) => {
    const targetPeer = findPeerByConnectionId(targetId);
    if (targetPeer) {
      targetPeer.socket.emit('camera-response', { hostId: socket.connectionId, accepted });
    }
  });

  socket.on('camera-ready', ({ targetId }) => {
    const targetPeer = findPeerByConnectionId(targetId);
    if (targetPeer) {
      targetPeer.socket.emit('camera-ready', { hostId: socket.connectionId });
    }
  });

  // WebRTC signaling
  socket.on('webrtc-offer', ({ targetId, offer }) => {
    console.log(`[Server] Forwarding offer from ${socket.connectionId} to ${targetId}`);
    const targetPeer = findPeerByConnectionId(targetId);
    if (targetPeer) {
      targetPeer.socket.emit('webrtc-offer', { fromId: socket.connectionId, offer });
    } else {
      console.error(`[Server] Target peer ${targetId} not found!`);
    }
  });

  socket.on('webrtc-answer', ({ targetId, answer }) => {
    console.log(`[Server] Forwarding answer from ${socket.connectionId} to ${targetId}`);
    const targetPeer = findPeerByConnectionId(targetId);
    if (targetPeer) {
      targetPeer.socket.emit('webrtc-answer', { fromId: socket.connectionId, answer });
    } else {
      console.error(`[Server] Target peer ${targetId} not found!`);
    }
  });

  socket.on('webrtc-ice-candidate', ({ targetId, candidate }) => {
    const targetPeer = findPeerByConnectionId(targetId);
    if (targetPeer) {
      targetPeer.socket.emit('webrtc-ice-candidate', { fromId: socket.connectionId, candidate });
    }
  });

  // End session
  socket.on('end-session', ({ targetId }) => {
    const targetPeer = findPeerByConnectionId(targetId);
    if (targetPeer) {
      targetPeer.status = 'available';
      targetPeer.connectedTo = null;
      targetPeer.socket.emit('session-ended', { fromId: socket.connectionId });
    }
    const ownPeer = peers.get(socket.connectionId);
    if (ownPeer) {
      ownPeer.status = 'available';
      ownPeer.connectedTo = null;
    }
  });

  // Handle disconnect with grace period
  socket.on('disconnect', () => {
    console.log(`[Server] Disconnected: ${socket.id}`);
    if (socket.connectionId) {
      const disconnectedId = socket.connectionId;
      
      // Give a 10s grace period before notifying peers and cleaning up
      setTimeout(() => {
        const peer = peers.get(disconnectedId);
        // If peer re-registered with same ID during grace period, skip cleanup
        if (peer && peer.socketId !== socket.id) {
          console.log(`[Server] Peer ${disconnectedId} reconnected during grace period, skipping cleanup`);
          return;
        }
        if (!peer) {
          console.log(`[Server] Peer ${disconnectedId} already cleaned up`);
          return;
        }
        
        if (peer.connectedTo) {
          const connectedPeer = findPeerByConnectionId(peer.connectedTo);
          if (connectedPeer) {
            connectedPeer.socket.emit('peer-disconnected', { peerId: disconnectedId });
            connectedPeer.status = 'available';
            connectedPeer.connectedTo = null;
          }
        }
        for (const [requestId, request] of pendingConnections.entries()) {
          if (request.hostConnectionId === disconnectedId) {
            const viewerPeer = Array.from(peers.values()).find(p => p.socketId === request.viewerSocketId);
            if (viewerPeer) {
              viewerPeer.socket.emit('connection-rejected', { error: 'Peer disconnected' });
            }
            pendingConnections.delete(requestId);
          } else if (request.viewerConnectionId === disconnectedId) {
            pendingConnections.delete(requestId);
          }
        }
        peers.delete(disconnectedId);
        console.log(`[Server] Peer unregistered: ${disconnectedId} (remaining: ${peers.size})`);
      }, 10000);
    }
  });
});

// =====================
// Start Server
// =====================

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('='.repeat(50));
  console.log('  Remote Desktop Signaling Server (PUBLIC)');
  console.log('='.repeat(50));
  console.log(`  Listening on port ${PORT}`);
  console.log(`  Status: READY`);
  console.log('='.repeat(50));
  console.log('');
});
