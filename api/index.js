import fetch from "node-fetch";

// Constants
const BASE_URL = "https://api.jikan.moe/v4";
const CACHE_DURATION = 60 * 60 * 1000; // 1 hour in milliseconds

// In-memory cache (will reset on each deployment/function cold start)
const cache = new Map();

// Statistics for monitoring
const stats = {
  requests: 0,
  cacheHits: 0,
  cacheMisses: 0,
  errors: 0,
  startTime: Date.now(),
  endpoints: {},
  responseTime: []
};

// Function to fetch with cache
async function fetchWithCache(url, cacheKey, cacheDuration = CACHE_DURATION) {
  const now = Date.now();
  
  // Check cache
  if (cache.has(cacheKey)) {
    const cachedData = cache.get(cacheKey);
    if (now - cachedData.timestamp < cachedData.duration) {
      stats.cacheHits++;
      console.log(`Cache hit: ${cacheKey}`);
      return cachedData.data;
    } else {
      console.log(`Cache expired: ${cacheKey}`);
      cache.delete(cacheKey);
    }
  }
  
  // If not in cache or expired, fetch from API
  stats.cacheMisses++;
  console.log(`Cache miss: ${cacheKey}`);
  const response = await fetch(url);
  
  if (!response.ok) {
    const errorText = await response.text();
    console.error(`API error (${response.status}): ${errorText}`);
    throw new Error(`API responded with status: ${response.status} - ${errorText}`);
  }
  
  const data = await response.json();
  
  // Save in cache
  cache.set(cacheKey, {
    timestamp: now,
    duration: cacheDuration,
    data: data
  });
  
  return data;
}

// Performance middleware
function performanceMiddleware(handler) {
  return async (params) => {
    const endpoint = handler.name;
    
    // Initialize endpoint statistics if they don't exist
    if (!stats.endpoints[endpoint]) {
      stats.endpoints[endpoint] = {
        calls: 0,
        errors: 0,
        totalResponseTime: 0
      };
    }
    
    stats.endpoints[endpoint].calls++;
    stats.requests++;
    
    const startTime = performance.now();
    
    try {
      const result = await handler(params);
      const endTime = performance.now();
      const responseTime = endTime - startTime;
      
      stats.endpoints[endpoint].totalResponseTime += responseTime;
      stats.responseTime.push(responseTime);
      
      // Only keep the last 1000 samples for average calculation
      if (stats.responseTime.length > 1000) {
        stats.responseTime.shift();
      }
      
      return result;
    } catch (error) {
      stats.endpoints[endpoint].errors++;
      stats.errors++;
      throw error;
    }
  };
}

// Handlers for various Jikan API endpoints
const handlers = {
  // Anime
  async anime(params) {
    const id = params.get("id");
    if (id) {
      return await fetchWithCache(
        `${BASE_URL}/anime/${id}`,
        `anime_${id}`
      );
    }
    
    const query = new URLSearchParams();
    for (const [key, value] of params.entries()) {
      query.append(key, value);
    }
    
    return await fetchWithCache(
      `${BASE_URL}/anime?${query.toString()}`,
      `anime_search_${query.toString()}`
    );
  },
  
  // Manga
  async manga(params) {
    const id = params.get("id");
    if (id) {
      return await fetchWithCache(
        `${BASE_URL}/manga/${id}`,
        `manga_${id}`
      );
    }
    
    const query = new URLSearchParams();
    for (const [key, value] of params.entries()) {
      query.append(key, value);
    }
    
    return await fetchWithCache(
      `${BASE_URL}/manga?${query.toString()}`,
      `manga_search_${query.toString()}`
    );
  },
  
  // Seasons
  async seasons(params) {
    const year = params.get("year");
    const season = params.get("season");
    
    if (year && season) {
      return await fetchWithCache(
        `${BASE_URL}/seasons/${year}/${season}`,
        `season_${year}_${season}`,
        12 * 60 * 60 * 1000 // 12 hours for seasonal
      );
    }
    
    if (params.get("now") === "true") {
      return await fetchWithCache(
        `${BASE_URL}/seasons/now`,
        `season_now`,
        6 * 60 * 60 * 1000 // 6 hours for current season
      );
    }
    
    return await fetchWithCache(
      `${BASE_URL}/seasons`,
      `seasons_list`,
      24 * 60 * 60 * 1000 // 24 hours for seasons list
    );
  },
  
  // Top
  async top(params) {
    const type = params.get("type") || "anime";
    const filter = params.get("filter") || "";
    const page = params.get("page") || "1";
    
    let url = `${BASE_URL}/top/${type}`;
    if (filter) url += `/${filter}`;
    url += `?page=${page}`;
    
    return await fetchWithCache(
      url,
      `top_${type}_${filter}_${page}`,
      3 * 60 * 60 * 1000 // 3 hours for top charts
    );
  },
  
  // Schedule
  async schedule(params) {
    const day = params.get("day") || "";
    
    return await fetchWithCache(
      `${BASE_URL}/schedules${day ? `/${day}` : ''}`,
      `schedule_${day || 'all'}`,
      12 * 60 * 60 * 1000 // 12 hours for schedule
    );
  },
  
  // Genres
  async genres(params) {
    const type = params.get("type") || "anime";
    
    return await fetchWithCache(
      `${BASE_URL}/genres/${type}`,
      `genres_${type}`,
      7 * 24 * 60 * 60 * 1000 // 7 days for genres (rarely change)
    );
  },
  
  // Characters
  async characters(params) {
    const id = params.get("id");
    if (id) {
      return await fetchWithCache(
        `${BASE_URL}/characters/${id}`,
        `character_${id}`,
        7 * 24 * 60 * 60 * 1000 // 7 days for character info
      );
    }
    
    const query = new URLSearchParams();
    for (const [key, value] of params.entries()) {
      if (key !== "id") query.append(key, value);
    }
    
    return await fetchWithCache(
      `${BASE_URL}/characters?${query.toString()}`,
      `characters_search_${query.toString()}`
    );
  },
  
  // People
  async people(params) {
    const id = params.get("id");
    if (id) {
      return await fetchWithCache(
        `${BASE_URL}/people/${id}`,
        `person_${id}`,
        7 * 24 * 60 * 60 * 1000 // 7 days for person info
      );
    }
    
    const query = new URLSearchParams();
    for (const [key, value] of params.entries()) {
      if (key !== "id") query.append(key, value);
    }
    
    return await fetchWithCache(
      `${BASE_URL}/people?${query.toString()}`,
      `people_search_${query.toString()}`
    );
  },
  
  // Random
  async random(params) {
    const type = params.get("type") || "anime";
    // Random always fetches new data, not cached
    const response = await fetch(`${BASE_URL}/random/${type}`);
    if (!response.ok) {
      throw new Error(`Random API responded with status: ${response.status}`);
    }
    return await response.json();
  },
  
  // Reviews
  async reviews(params) {
    const type = params.get("type") || "anime";
    const page = params.get("page") || "1";
    
    return await fetchWithCache(
      `${BASE_URL}/reviews/${type}?page=${page}`,
      `reviews_${type}_${page}`,
      6 * 60 * 60 * 1000 // 6 hours for reviews
    );
  },
  
  // Recommendations
  async recommendations(params) {
    const type = params.get("type") || "anime";
    const page = params.get("page") || "1";
    
    return await fetchWithCache(
      `${BASE_URL}/recommendations/${type}?page=${page}`,
      `recommendations_${type}_${page}`,
      12 * 60 * 60 * 1000 // 12 hours for recommendations
    );
  },
  
  // Studios
  async studios(params) {
    const id = params.get("id");
    if (id) {
      return await fetchWithCache(
        `${BASE_URL}/studios/${id}`,
        `studio_${id}`,
        7 * 24 * 60 * 60 * 1000 // 7 days for studio info
      );
    }
    
    return await fetchWithCache(
      `${BASE_URL}/studios`,
      `studios_list`,
      7 * 24 * 60 * 60 * 1000 // 7 days for studios list
    );
  },
  
  // Stats
  async stats(params) {
    // Special endpoint to view server statistics
    const averageResponseTime = stats.responseTime.length > 0
      ? stats.responseTime.reduce((sum, time) => sum + time, 0) / stats.responseTime.length
      : 0;
    
    const uptime = Math.floor((Date.now() - stats.startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = uptime % 60;
    
    return {
      uptime: `${hours}h ${minutes}m ${seconds}s`,
      requests: stats.requests,
      cacheHits: stats.cacheHits,
      cacheMisses: stats.cacheMisses,
      cacheRatio: stats.requests > 0 ? (stats.cacheHits / stats.requests * 100).toFixed(2) + "%" : "0%",
      errors: stats.errors,
      cacheSize: cache.size,
      averageResponseTime: averageResponseTime.toFixed(2) + "ms",
      endpoints: Object.entries(stats.endpoints).map(([name, data]) => ({
        name,
        calls: data.calls,
        errors: data.errors,
        averageResponseTime: data.calls > 0 
          ? (data.totalResponseTime / data.calls).toFixed(2) + "ms" 
          : "0ms",
        errorRate: data.calls > 0 
          ? (data.errors / data.calls * 100).toFixed(2) + "%" 
          : "0%"
      }))
    };
  }
};

// Add performance middleware to all handlers
const handlersWithStats = Object.fromEntries(
  Object.entries(handlers).map(([name, handler]) => [
    name, 
    performanceMiddleware(Object.defineProperty(handler, 'name', { value: name }))
  ])
);

// Main handler function
export default async function handler(req, res) {
  const requestStartTime = performance.now();
  const url = new URL(req.url, `https://${req.headers.host}`);
  const path = url.pathname.toLowerCase();
  const searchParams = url.searchParams;
  const clientIP = req.headers['x-forwarded-for'] || 'unknown';
  
  // Log request
  console.log(`${clientIP} - ${req.method} ${path}${url.search}`);
  
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  
  // Extract endpoint from path
  const parts = path.split('/').filter(Boolean);
  
  // Home page with API documentation
  if (parts.length < 1 || (parts.length === 1 && parts[0] === 'api')) {
    res.status(200).json({
      message: "Jikan API Proxy with High Performance Caching",
      version: "1.1.0",
      endpoints: {
        "/api/anime": "Search anime or get by ID with ?id=123",
        "/api/manga": "Search manga or get by ID with ?id=123",
        "/api/seasons": "Get anime by season",
        "/api/seasons?now=true": "Get current season anime",
        "/api/top": "Get top anime/manga with ?type=anime|manga",
        "/api/schedule": "Get anime schedule with ?day=day",
        "/api/genres": "Get genres with ?type=anime|manga",
        "/api/characters": "Search characters or get by ID with ?id=123",
        "/api/people": "Search people or get by ID with ?id=123",
        "/api/random": "Get random anime/manga with ?type=anime|manga",
        "/api/reviews": "Get reviews with ?type=anime|manga",
        "/api/recommendations": "Get recommendations with ?type=anime|manga",
        "/api/studios": "Get studios list or details with ?id=123",
        "/api/stats": "Get server statistics"
      },
      documentation: "Access /api/stats to see server performance"
    });
    return;
  }
  
  // Get the endpoint (remove 'api' if present)
  const endpoint = parts[0] === 'api' ? parts[1] : parts[0];
  
  // Check if endpoint exists
  if (!handlersWithStats[endpoint]) {
    console.warn(`404 - Endpoint not found: ${endpoint}`);
    res.status(404).json({ 
      error: "Endpoint not found",
      available_endpoints: Object.keys(handlersWithStats)
    });
    return;
  }
  
  try {
    // Process the request
    const jikanData = await handlersWithStats[endpoint](searchParams);
    
    // Add own metadata
    const enhancedData = {
      source: "Jikan API Proxy",
      cached: endpoint !== "random" && endpoint !== "stats",
      timestamp: new Date().toISOString(),
      endpoint: endpoint,
      ...jikanData
    };
    
    const requestEndTime = performance.now();
    console.log(`Request completed in ${(requestEndTime - requestStartTime).toFixed(2)}ms: ${path}`);
    
    res.status(200).json(enhancedData);
  } catch (error) {
    const errorMessage = error.message || "Unknown error";
    console.error(`Error handling ${endpoint}: ${errorMessage}`);
    
    res.status(500).json({ 
      error: "Failed to fetch data",
      message: errorMessage,
      endpoint: endpoint
    });
  }
}