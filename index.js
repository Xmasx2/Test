// Minimal-memory, Render.com-optimized Discord voice bot with Express for UptimeRobot
const { Client } = require('discord.js-selfbot-v13');
const { joinVoiceChannel, VoiceConnectionStatus } = require('@discordjs/voice');
const express = require('express');

// --- RENDER.COM FRIENDLY ENV HANDLING ---
const config = {
  token: process.env.DISCORD_TOKEN,
  guildId: process.env.GUILD_ID,
  channelId: process.env.CHANNEL_ID,
  reconnectDelay: +(process.env.RECONNECT_DELAY || 5000),
  maxReconnectAttempts: +(process.env.MAX_RECONNECT_ATTEMPTS || 10),
  healthCheckInterval: +(process.env.HEALTH_CHECK_INTERVAL || 300000), // 5 min
  port: +(process.env.PORT || 3000),
};

// Render.com: Exit ASAP if config missing (prevents endless restarts)
if (!config.token || !config.guildId || !config.channelId) {
  console.error('Missing required env vars: DISCORD_TOKEN, GUILD_ID, CHANNEL_ID');
  process.exit(1);
}

const client = new Client({
  checkUpdate: false,
  patchVoice: true,
  ws: { properties: { $browser: "Discord Android" } }
});

let connection = null;
let reconnectTimeout = null;
let reconnectAttempts = 0;
let lastConnectedTime = 0;
let healthCheckIntervalId = null;

// --- EXPRESS FOR UPTIME ROBOT ---
const app = express();
app.get('/', (req, res) => res.send('OK'));
app.get('/health', (req, res) => res.send('OK'));
app.listen(config.port, () => {
  console.log(`UptimeRobot health endpoint listening on port ${config.port}`);
});

// --- CORE LOGIC ---

async function connectToVoiceChannel() {
  clearTimeout(reconnectTimeout);
  try {
    const guild = client.guilds.cache.get(config.guildId);
    if (!guild) return handleReconnection('GUILD_NOT_FOUND');
    const channel = guild.channels.cache.get(config.channelId);
    if (!channel) return handleReconnection('CHANNEL_NOT_FOUND');

    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: true
    });

    connection.on('stateChange', (oldState, newState) => {
      if (newState.status === VoiceConnectionStatus.Ready) {
        reconnectAttempts = 0;
        lastConnectedTime = Date.now();
      } else if (newState.status === VoiceConnectionStatus.Disconnected) {
        safeDestroyConnection();
        handleReconnection('VOICE_DISCONNECTED');
      } else if (newState.status === VoiceConnectionStatus.Destroyed) {
        connection = null;
      }
    });

    connection.on('error', handleReconnection);

  } catch (e) {
    handleReconnection(e);
  }
}

function handleReconnection(reason) {
  reconnectAttempts++;
  if (reconnectAttempts > config.maxReconnectAttempts) {
    restartClient();
    return;
  }
  const delay = Math.min(config.reconnectDelay * (1.5 ** (reconnectAttempts - 1)), 300000);
  clearTimeout(reconnectTimeout);
  reconnectTimeout = setTimeout(connectToVoiceChannel, delay);
}

function restartClient() {
  clearTimeout(reconnectTimeout);
  safeDestroyConnection();
  client.destroy();
  reconnectAttempts = 0;
  // For Render.com, let the process exit for a clean restart (auto-restart)
  setTimeout(() => process.exit(1), 2000);
}

function loginClient() {
  client.login(config.token)
    .catch(() => setTimeout(loginClient, config.reconnectDelay));
}

function performHealthCheck() {
  if (!client.user) return restartClient();
  if (!connection) return connectToVoiceChannel();
  if (lastConnectedTime && (Date.now() - lastConnectedTime > 3600000)) {
    safeDestroyConnection();
    connectToVoiceChannel();
  }
}

function safeDestroyConnection() {
  if (connection) {
    try { connection.destroy(); } catch (_) {}
    connection = null;
  }
}

function cleanup() {
  clearTimeout(reconnectTimeout);
  if (healthCheckIntervalId) clearInterval(healthCheckIntervalId);
  safeDestroyConnection();
  client.destroy();
}

// --- EVENT HANDLERS ---

client.once('ready', () => {
  connectToVoiceChannel();
  healthCheckIntervalId = setInterval(performHealthCheck, config.healthCheckInterval);
});

client.on('disconnect', () => {
  handleReconnection('GATEWAY_DISCONNECT');
});

process.on('unhandledRejection', restartClient);

['SIGINT', 'SIGTERM'].forEach(signal =>
  process.on(signal, () => { cleanup(); process.exit(0); })
);

// --- STARTUP ---
loginClient();
