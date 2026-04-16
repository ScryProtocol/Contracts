# Twitch Chat Viewer

A real-time Twitch stream viewer that monitors the top 100 streams and ranks them by chat activity (messages per second).

## Features

- 📊 Monitors top 100 Twitch streams in real-time
- 💬 Calculates chat rate (messages/second) for each stream
- 🏆 Displays top 10 streams ranked by chat activity
- 🎮 Embedded Twitch player with live chat
- 🔄 Auto-refreshes stream list every 5 minutes
- ⚡ Real-time chat rate updates every 2 seconds

## Setup

1. Install dependencies:
```bash
cd twitch-chat-viewer
npm install
```

2. Your Twitch API credentials are already configured in `.env`:
- Client ID: `ffb9biwgc9cqmzx8bk6l7wufw6t46b`
- Access Token: `bfqh9gub1y2mg0xaxpxgam462ko1q0`

3. Start the app:
```bash
npm start
```

The app will open at `http://localhost:3000`

## How It Works

1. **Fetch Top Streams**: Uses Twitch Helix API to get the top 100 live streams
2. **Monitor Chat**: Connects to each stream's chat using TMI.js (Twitch Messaging Interface)
3. **Calculate Rate**: Tracks messages over time and calculates messages per second
4. **Rank & Display**: Sorts streams by chat activity and shows top 10
5. **Watch & Chat**: Click any stream to watch with embedded player and live chat

## Usage

- Browse the top 10 streams on the left sidebar
- Click on any stream to watch it
- Chat rate updates in real-time
- Stream rankings adjust automatically based on chat activity

## Tech Stack

- React 18 + TypeScript
- Twitch Helix API (stream data)
- TMI.js (chat monitoring)
- Twitch Embed (player & chat)
- CSS (Twitch-style dark theme)
