import { serve } from "bun";
import { fetch } from "bun";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const BASE_URL = "https://api.jikan.moe/v4";
const PORT = process.env.PORT || 3000;
const CACHE_DURATION = 60 * 60 * 1000; // 1 jam dalam milidetik
const CACHE_DIR = "./cache";
const LOGS_DIR = "./logs";

// Buat direktori cache dan logs jika belum ada
if (!existsSync(CACHE_DIR)) {
  mkdirSync(CACHE_DIR);
}
if (!existsSync(LOGS_DIR)) {
  mkdirSync(LOGS_DIR);
}

// Statistik untuk monitoring
const stats = {
  requests: 0,
  cacheHits: 0,
  cacheMisses: 0,
  errors: 0,
  startTime: Date.now(),
  endpoints: {},
  responseTime: [] // array untuk menampung waktu respons
};

// Cache dengan opsi persistensi ke disk
const cache = new Map();

// Inisialisasi cache dari disk jika ada
try {
  if (existsSync(join(CACHE_DIR, "cache-index.json"))) {
    const cacheIndex = JSON.parse(readFileSync(join(CACHE_DIR, "cache-index.json"), "utf8"));
    for (const key of cacheIndex.keys) {
      try {
        const cacheFilePath = join(CACHE_DIR, `${Buffer.from(key).toString("base64")}.json`);
        if (existsSync(cacheFilePath)) {
          const cachedItem = JSON.parse(readFileSync(cacheFilePath, "utf8"));
          if (Date.now() - cachedItem.timestamp < cachedItem.duration) {
            cache.set(key, cachedItem);
            console.log(`Loaded from disk cache: ${key}`);
          }
        }
      } catch (err) {
        console.error(`Error loading cache item ${key}:`, err);
      }
    }
    console.log(`Loaded ${cache.size} items from disk cache`);
  }
} catch (err) {
  console.error("Error loading cache from disk:", err);
}

// Fungsi untuk menyimpan cache ke disk
function saveCacheToDisk() {
  try {
    // Simpan indeks cache
    const keys = Array.from(cache.keys());
    writeFileSync(join(CACHE_DIR, "cache-index.json"), JSON.stringify({ keys }));
    
    // Simpan setiap item cache
    for (const [key, value] of cache.entries()) {
      const fileName = Buffer.from(key).toString("base64");
      writeFileSync(join(CACHE_DIR, `${fileName}.json`), JSON.stringify(value));
    }
    console.log(`Saved ${cache.size} items to disk cache`);
  } catch (err) {
    console.error("Error saving cache to disk:", err);
  }
}

// Fungsi logging
function log(message, level = "info") {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
  
  console.log(logMessage);
  
  // Log ke file berdasarkan tanggal
  const today = new Date().toISOString().split("T")[0];
  const logFile = join(LOGS_DIR, `${today}.log`);
  
  try {
    writeFileSync(logFile, logMessage + "\n", { flag: "a" });
  } catch (err) {
    console.error("Error writing to log file:", err);
  }
}

// Fungsi untuk mengambil data dengan caching
async function fetchWithCache(url, cacheKey, cacheDuration = CACHE_DURATION) {
  const now = Date.now();
  
  // Periksa cache
  if (cache.has(cacheKey)) {
    const cachedData = cache.get(cacheKey);
    if (now - cachedData.timestamp < cachedData.duration) {
      stats.cacheHits++;
      log(`Cache hit: ${cacheKey}`);
      return cachedData.data;
    } else {
      log(`Cache expired: ${cacheKey}`);
      cache.delete(cacheKey);
    }
  }
  
  // Jika tidak ada di cache atau sudah kadaluarsa, ambil dari API
  stats.cacheMisses++;
  log(`Cache miss: ${cacheKey}`);
  const response = await fetch(url);
  
  if (!response.ok) {
    const errorText = await response.text();
    log(`API error (${response.status}): ${errorText}`, "error");
    throw new Error(`API responded with status: ${response.status} - ${errorText}`);
  }
  
  const data = await response.json();
  
  // Simpan di cache
  cache.set(cacheKey, {
    timestamp: now,
    duration: cacheDuration,
    data: data
  });
  
  // Simpan cache ke disk setiap 100 cache miss
  if (stats.cacheMisses % 100 === 0) {
    saveCacheToDisk();
  }
  
  return data;
}

// Rate limiting untuk Jikan API (4 request per detik)
const requestQueue = [];
const MAX_REQUESTS_PER_SECOND = 4;
let processingQueue = false;

async function processQueue() {
  if (processingQueue || requestQueue.length === 0) return;
  
  processingQueue = true;
  
  const batch = requestQueue.splice(0, MAX_REQUESTS_PER_SECOND);
  const promises = batch.map(async ({ resolve, reject, fn }) => {
    try {
      const result = await fn();
      resolve(result);
    } catch (error) {
      reject(error);
    }
  });
  
  await Promise.all(promises);
  
  // Tunggu sedikit untuk menghormati rate limit
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  processingQueue = false;
  processQueue();
}

function enqueueRequest(fn) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ resolve, reject, fn });
    processQueue();
  });
}

// Middleware untuk penghitung performa dan statistik
function performanceMiddleware(handler) {
  return async (params) => {
    const endpoint = handler.name;
    
    // Inisialisasi statistik endpoint jika belum ada
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
      
      // Hanya simpan 1000 sampel terakhir untuk perhitungan rata-rata
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

// Handle untuk berbagai endpoint Jikan API
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
        12 * 60 * 60 * 1000 // 12 jam untuk musiman
      );
    }
    
    if (params.get("now") === "true") {
      return await fetchWithCache(
        `${BASE_URL}/seasons/now`,
        `season_now`,
        6 * 60 * 60 * 1000 // 6 jam untuk musim sekarang
      );
    }
    
    return await fetchWithCache(
      `${BASE_URL}/seasons`,
      `seasons_list`,
      24 * 60 * 60 * 1000 // 24 jam untuk daftar musim
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
      3 * 60 * 60 * 1000 // 3 jam untuk top charts
    );
  },
  
  // Schedule
  async schedule(params) {
    const day = params.get("day") || "";
    
    return await fetchWithCache(
      `${BASE_URL}/schedules${day ? `/${day}` : ''}`,
      `schedule_${day || 'all'}`,
      12 * 60 * 60 * 1000 // 12 jam untuk jadwal
    );
  },
  
  // Genres
  async genres(params) {
    const type = params.get("type") || "anime";
    
    return await fetchWithCache(
      `${BASE_URL}/genres/${type}`,
      `genres_${type}`,
      7 * 24 * 60 * 60 * 1000 // 7 hari untuk genre (jarang berubah)
    );
  },
  
  // Characters
  async characters(params) {
    const id = params.get("id");
    if (id) {
      return await fetchWithCache(
        `${BASE_URL}/characters/${id}`,
        `character_${id}`,
        7 * 24 * 60 * 60 * 1000 // 7 hari untuk info karakter
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
        7 * 24 * 60 * 60 * 1000 // 7 hari untuk info orang
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
    // Random selalu mengambil data baru, tidak di-cache
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
      6 * 60 * 60 * 1000 // 6 jam untuk reviews
    );
  },
  
  // Recommendations
  async recommendations(params) {
    const type = params.get("type") || "anime";
    const page = params.get("page") || "1";
    
    return await fetchWithCache(
      `${BASE_URL}/recommendations/${type}?page=${page}`,
      `recommendations_${type}_${page}`,
      12 * 60 * 60 * 1000 // 12 jam untuk rekomendasi
    );
  },
  
  // Studios
  async studios(params) {
    const id = params.get("id");
    if (id) {
      return await fetchWithCache(
        `${BASE_URL}/studios/${id}`,
        `studio_${id}`,
        7 * 24 * 60 * 60 * 1000 // 7 hari untuk info studio
      );
    }
    
    return await fetchWithCache(
      `${BASE_URL}/studios`,
      `studios_list`,
      7 * 24 * 60 * 60 * 1000 // 7 hari untuk daftar studio
    );
  },
  
  // Stats
  async stats(params) {
    // Endpoint spesial untuk melihat statistik server
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
      })),
      queueLength: requestQueue.length
    };
  }
};

// Tambahkan middleware performa untuk semua handler
const handlersWithStats = Object.fromEntries(
  Object.entries(handlers).map(([name, handler]) => [
    name, 
    performanceMiddleware(Object.defineProperty(handler, 'name', { value: name }))
  ])
);

// Server
const server = serve({
  port: PORT,
  async fetch(req) {
    const requestStartTime = performance.now();
    const url = new URL(req.url);
    const path = url.pathname.toLowerCase();
    const searchParams = url.searchParams;
    const clientIP = req.headers.get("x-forwarded-for") || "unknown";
    
    // CORS headers
    const headers = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Cache-Control": "public, max-age=3600"
    };
    
    // Handle preflight requests
    if (req.method === "OPTIONS") {
      return new Response(null, { headers });
    }
    
    // Log request
    log(`${clientIP} - ${req.method} ${path}${url.search}`);
    
    // Extract endpoint dari path
    const parts = path.split('/').filter(Boolean);
    if (parts.length < 2 || parts[0] !== 'api') {
      // Berikan dokumentasi API jika ini home page
      return new Response(JSON.stringify({
        message: "Jikan API Proxy with High Performance Caching",
        version: "1.1.0",
        endpoints: {
          "/api/anime": "Cari anime atau dapatkan by ID dengan ?id=123",
          "/api/manga": "Cari manga atau dapatkan by ID dengan ?id=123",
          "/api/seasons": "Dapatkan anime berdasarkan musim",
          "/api/seasons?now=true": "Dapatkan anime musim sekarang",
          "/api/top": "Dapatkan top anime/manga dengan ?type=anime|manga",
          "/api/schedule": "Dapatkan jadwal anime dengan ?day=hari",
          "/api/genres": "Dapatkan genre dengan ?type=anime|manga",
          "/api/characters": "Cari karakter atau dapatkan by ID dengan ?id=123",
          "/api/people": "Cari orang atau dapatkan by ID dengan ?id=123",
          "/api/random": "Dapatkan anime/manga acak dengan ?type=anime|manga",
          "/api/reviews": "Dapatkan review dengan ?type=anime|manga",
          "/api/recommendations": "Dapatkan rekomendasi dengan ?type=anime|manga",
          "/api/studios": "Dapatkan daftar studio atau detail dengan ?id=123",
          "/api/stats": "Dapatkan statistik server"
        },
        documentation: "Akses /api/stats untuk melihat performa server"
      }), {
        headers
      });
    }
    
    const endpoint = parts[1];
    
    // Periksa apakah endpoint ada
    if (!handlersWithStats[endpoint]) {
      log(`404 - Endpoint tidak ditemukan: ${endpoint}`, "warn");
      return new Response(JSON.stringify({ 
        error: "Endpoint tidak ditemukan",
        available_endpoints: Object.keys(handlersWithStats)
      }), {
        status: 404,
        headers
      });
    }
    
    try {
      // Pakai enqueue untuk rate limiting
      const jikanData = await enqueueRequest(async () => {
        return await handlersWithStats[endpoint](searchParams);
      });
      
      // Tambahkan metadata sendiri
      const enhancedData = {
        source: "Jikan API Proxy",
        cached: endpoint !== "random" && endpoint !== "stats",
        timestamp: new Date().toISOString(),
        endpoint: endpoint,
        ...jikanData
      };
      
      const requestEndTime = performance.now();
      log(`Request completed in ${(requestEndTime - requestStartTime).toFixed(2)}ms: ${path}`);
      
      return new Response(JSON.stringify(enhancedData), { headers });
    } catch (error) {
      const errorMessage = error.message || "Unknown error";
      log(`Error handling ${endpoint}: ${errorMessage}`, "error");
      
      return new Response(JSON.stringify({ 
        error: "Gagal mengambil data",
        message: errorMessage,
        endpoint: endpoint
      }), {
        status: 500,
        headers
      });
    }
  }
});

console.log(`Jikan API Proxy running at http://localhost:${PORT}`);
console.log(`Cache active with ${CACHE_DURATION/1000/60} minutes default duration`);

// Membersihkan cache yang sudah kadaluarsa setiap jam
setInterval(() => {
  const now = Date.now();
  let removed = 0;
  
  for (const [key, value] of cache.entries()) {
    if (now - value.timestamp > value.duration) {
      cache.delete(key);
      removed++;
    }
  }
  
  if (removed > 0) {
    log(`Cache cleanup: removed ${removed} entries`);
  }
}, 60 * 60 * 1000); // Bersihkan setiap jam

// Simpan cache ke disk setiap 30 menit
setInterval(() => {
  saveCacheToDisk();
}, 30 * 60 * 1000);

// Tangani sinyal shutdown untuk menyimpan cache sebelum exit
process.on("SIGINT", () => {
  console.log("Shutting down, saving cache...");
  saveCacheToDisk();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("Shutting down, saving cache...");
  saveCacheToDisk();
  process.exit(0);
});