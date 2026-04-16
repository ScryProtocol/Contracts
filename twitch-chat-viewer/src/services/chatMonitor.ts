// Frontend IRC chat monitoring using WebSocket
// Uses a single WebSocket connection to join multiple channels (like tmi.js)

export interface ChatMetrics {
  messageCount: number;
  chatRate: number;
  chatRate10s: number;
  chatRate5m: number;
  lastUpdate: number;
}

interface MessageTimestamp {
  timestamp: number;
}

// Spam filter settings
export interface SpamFilterSettings {
  filterVotes: boolean;
  filterCommands: boolean;
}

function isSpamMessage(content: string, settings: SpamFilterSettings): boolean {
  const trimmed = content.trim();
  if (settings.filterVotes && /^[1-9]$/.test(trimmed)) return true;
  if (settings.filterCommands && /^![\w]+$/.test(trimmed)) return true;
  return false;
}

type MetricsCallback = (metrics: Map<string, ChatMetrics>) => void;

export class ChatMonitor {
  private ws: WebSocket | null = null;
  private channels: Set<string> = new Set();
  private metrics: Map<string, { messageCount: number; messages: MessageTimestamp[]; startedAt: number }> = new Map();
  private updateInterval: ReturnType<typeof setInterval> | null = null;
  private onMetricsUpdate: MetricsCallback | null = null;
  private maxChannels = 100;
  private priorityChannels: Set<string> = new Set(); // followed + custom streams
  private connected = false;
  private connectPromise: Promise<void> | null = null;
  private spamFilter: SpamFilterSettings = { filterVotes: true, filterCommands: true };

  setSpamFilter(settings: SpamFilterSettings) {
    this.spamFilter = settings;
  }

  constructor() {
    this.startMetricsInterval();
  }

  private startMetricsInterval() {
    if (this.updateInterval) return;

    this.updateInterval = setInterval(() => {
      if (this.onMetricsUpdate) {
        this.onMetricsUpdate(this.getAllMetrics());
      }
    }, 1000);
  }

  setMetricsCallback(callback: MetricsCallback) {
    this.onMetricsUpdate = callback;
  }

  getAllMetrics(): Map<string, ChatMetrics> {
    const now = Date.now();
    const window10s = 10 * 1000;
    const window5m = 5 * 60 * 1000;

    const result = new Map<string, ChatMetrics>();

    this.metrics.forEach((metric, channel) => {
      // Clean old messages (older than 5 minutes)
      metric.messages = metric.messages.filter(m => now - m.timestamp < window5m);

      const recent10s = metric.messages.filter(m => now - m.timestamp < window10s).length;
      const recent5m = metric.messages.length;

      // Use actual elapsed time for 5m rate (capped at 5 minutes)
      const elapsedSeconds = Math.min((now - metric.startedAt) / 1000, 300);
      // Need at least 30 seconds of data to calculate meaningful 5m rate
      const effectiveWindow = Math.max(elapsedSeconds, 30);

      result.set(channel, {
        chatRate: recent10s / 10,
        messageCount: metric.messageCount,
        chatRate10s: recent10s / 10,
        chatRate5m: recent5m / effectiveWindow,
        lastUpdate: now,
      });
    });

    return result;
  }

  getMetrics(channelName: string): ChatMetrics | undefined {
    const channel = channelName.toLowerCase();
    const metric = this.metrics.get(channel);
    if (!metric) return undefined;

    const now = Date.now();
    const window10s = 10 * 1000;
    const window5m = 5 * 60 * 1000;

    const recent10s = metric.messages.filter(m => now - m.timestamp < window10s).length;
    const recent5m = metric.messages.filter(m => now - m.timestamp < window5m).length;

    // Use actual elapsed time for 5m rate (capped at 5 minutes)
    const elapsedSeconds = Math.min((now - metric.startedAt) / 1000, 300);
    // Need at least 30 seconds of data to calculate meaningful 5m rate
    const effectiveWindow = Math.max(elapsedSeconds, 30);

    return {
      chatRate: recent10s / 10,
      messageCount: metric.messageCount,
      chatRate10s: recent10s / 10,
      chatRate5m: recent5m / effectiveWindow,
      lastUpdate: now,
    };
  }

  getChatRate(channelName: string): number {
    const metrics = this.getMetrics(channelName);
    return metrics?.chatRate || 0;
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = new Promise((resolve) => {
      this.ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');

      this.ws.onopen = () => {
        // Wait a tick to ensure WebSocket is fully ready
        setTimeout(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            // Anonymous connection - no auth needed for read-only
            this.ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
            this.ws.send('PASS SCHMOOPIIE');
            this.ws.send('NICK justinfan' + Math.floor(Math.random() * 100000));
          }
        }, 0);
      };

      this.ws.onmessage = (event) => {
        const message = event.data as string;

        // Handle PING
        if (message.startsWith('PING')) {
          this.ws!.send('PONG :tmi.twitch.tv');
          return;
        }

        // Wait for welcome message (001) before marking as connected
        if (message.includes('001') && !this.connected) {
          this.connected = true;
          this.connectPromise = null;
          resolve();
          return;
        }

        // Check if it's a PRIVMSG (chat message) and extract channel + content
        if (message.includes('PRIVMSG #')) {
          // IRC format: @tags :user!user@user.tmi.twitch.tv PRIVMSG #channel :message content
          // Handle \r\n line endings from IRC
          const match = message.match(/PRIVMSG #(\w+) :(.*?)(?:\r?\n)?$/);
          if (match) {
            const channel = match[1].toLowerCase();
            const content = match[2];
            const metric = this.metrics.get(channel);
            if (metric) {
              // Only count non-spam messages
              if (!isSpamMessage(content, this.spamFilter)) {
                metric.messageCount++;
                metric.messages.push({ timestamp: Date.now() });
              }
            }
          }
        }
      };

      this.ws.onerror = () => {
        this.connected = false;
        this.connectPromise = null;
        resolve();
      };

      this.ws.onclose = () => {
        this.connected = false;
        this.connectPromise = null;
      };
    });

    return this.connectPromise;
  }

  async startMonitoring(channelName: string, isPriority: boolean = false): Promise<void> {
    const channel = channelName.toLowerCase();

    if (this.channels.has(channel)) {
      // Update priority status if needed
      if (isPriority) {
        this.priorityChannels.add(channel);
      }
      return;
    }

    // If at max, try to kick a non-priority channel for a priority one
    if (this.channels.size >= this.maxChannels) {
      if (isPriority) {
        // Find a non-priority channel to remove
        const nonPriorityChannel = Array.from(this.channels).find(c => !this.priorityChannels.has(c));
        if (nonPriorityChannel) {
          this.stopMonitoring(nonPriorityChannel);
        } else {
          return; // All channels are priority, can't add more
        }
      } else {
        return; // Non-priority channel and at max
      }
    }

    if (isPriority) {
      this.priorityChannels.add(channel);
    }

    await this.ensureConnected();

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(`JOIN #${channel}`);
      this.channels.add(channel);
      this.metrics.set(channel, {
        messageCount: 0,
        messages: [],
        startedAt: Date.now(),
      });
    }
  }

  stopMonitoring(channelName: string): void {
    const channel = channelName.toLowerCase();

    if (!this.channels.has(channel)) {
      return;
    }

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(`PART #${channel}`);
    }

    this.channels.delete(channel);
    this.metrics.delete(channel);
    this.priorityChannels.delete(channel);
  }

  async updateChannels(newChannels: string[]): Promise<void> {
    const newChannelSet = new Set(newChannels.map(c => c.toLowerCase()));

    // Part from channels no longer in list
    Array.from(this.channels).forEach(channel => {
      if (!newChannelSet.has(channel)) {
        this.stopMonitoring(channel);
      }
    });

    // Join new channels
    await this.ensureConnected();

    for (const channel of newChannels) {
      if (this.channels.size >= this.maxChannels) break;

      const lowerChannel = channel.toLowerCase();
      if (!this.channels.has(lowerChannel) && this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(`JOIN #${lowerChannel}`);
        this.channels.add(lowerChannel);
        this.metrics.set(lowerChannel, {
          messageCount: 0,
          messages: [],
          startedAt: Date.now(),
        });
      }
    }
  }

  stopAll(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.channels.clear();
    this.metrics.clear();
    this.priorityChannels.clear();
    this.connected = false;
    this.connectPromise = null;
  }
}

// Singleton instance
export const chatMonitor = new ChatMonitor();
