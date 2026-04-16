import axios from 'axios';
import { TwitchStream } from '../types';

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:3001';

const api = axios.create({
  baseURL: API_URL,
});

export interface TwitchUser {
  id: string;
  login: string;
  display_name: string;
  profile_image_url: string;
}

export const getTopStreams = async (limit: number = 100, language?: string): Promise<TwitchStream[]> => {
  try {
    const params: { limit: number; language?: string } = { limit };
    if (language && language !== 'all') {
      params.language = language;
    }
    const response = await api.get<TwitchStream[]>('/api/streams', { params });
    return response.data;
  } catch (error) {
    console.error('Error fetching streams:', error);
    throw error;
  }
};

export const getChatMetrics = async (): Promise<Record<string, { chatRate: number; messageCount: number }>> => {
  try {
    const response = await api.get('/api/chat-metrics');
    return response.data;
  } catch (error) {
    console.error('Error fetching chat metrics:', error);
    return {};
  }
};

// Auth functions
export const getAuthUrl = async (): Promise<string> => {
  const response = await api.get<{ url: string }>('/api/auth/twitch');
  return response.data.url;
};

export const getUser = async (session: string): Promise<TwitchUser | null> => {
  try {
    const response = await api.get<{ user: TwitchUser }>('/api/auth/user', {
      params: { session },
    });
    return response.data.user;
  } catch {
    return null;
  }
};

export const logout = async (session: string): Promise<void> => {
  await api.post('/api/auth/logout', null, {
    params: { session },
  });
};

export const getFollowedStreams = async (session: string): Promise<TwitchStream[]> => {
  try {
    const response = await api.get<TwitchStream[]>('/api/followed-streams', {
      params: { session },
    });
    return response.data;
  } catch (error) {
    console.error('Error fetching followed streams:', error);
    return [];
  }
};

export const getRecommendedStreams = async (session: string, language?: string): Promise<TwitchStream[]> => {
  try {
    const params: { session: string; language?: string } = { session };
    if (language && language !== 'all') {
      params.language = language;
    }
    const response = await api.get<TwitchStream[]>('/api/recommended-streams', { params });
    return response.data;
  } catch (error) {
    console.error('Error fetching recommended streams:', error);
    return [];
  }
};

// Visitor tracking
export const trackConnect = async (visitorId?: string, stream?: string): Promise<{ visitorId: string; active: number; total: number; peak: number; watchTime: number }> => {
  try {
    const response = await api.post('/api/connect', { visitorId, stream });
    return response.data;
  } catch (error) {
    console.error('Error tracking connect:', error);
    return { visitorId: visitorId || '', active: 0, total: 0, peak: 0, watchTime: 0 };
  }
};

export const trackDisconnect = async (visitorId: string): Promise<void> => {
  try {
    await api.post('/api/disconnect', { visitorId });
  } catch (error) {
    console.error('Error tracking disconnect:', error);
  }
};

