import { logger } from '.';
import { getNoteroPref, setNoteroPref } from '../prefs/notero-pref';


const IMGUR_CLIENT_ID = 'ac1c60b4788cfab';
const IMGUR_CACHE_PREF = 'imgurCache' as const;

interface ImgurCache {
  [fileHash: string]: {
    url: string;
    timestamp: number;
  };
}

// Load cache from Notero prefs
function loadCache(): ImgurCache {
  try {
    const cache = Components.classes["@mozilla.org/preferences-service;1"]
                           .getService(Components.interfaces.nsIPrefService)
                           .getBranch("extensions.notero.")
                           .getCharPref("imgurCache", "{}");
    logger.debug('Raw cache from prefs:', cache);
    const parsedCache = JSON.parse(cache);
    logger.debug('Parsed cache:', parsedCache);
    return parsedCache as ImgurCache;
  } catch (error) {
    logger.error('Error loading imgur cache:', error);
    return {};
  }
}

// Save cache to Notero prefs
function saveCache(cache: ImgurCache): void {
  try {
    const cacheString = JSON.stringify(cache);
    logger.debug('Saving cache string:', cacheString);
    Components.classes["@mozilla.org/preferences-service;1"]
             .getService(Components.interfaces.nsIPrefService)
             .getBranch("extensions.notero.")
             .setCharPref("imgurCache", cacheString);
    const savedCache = Components.classes["@mozilla.org/preferences-service;1"]
                                .getService(Components.interfaces.nsIPrefService)
                                .getBranch("extensions.notero.")
                                .getCharPref("imgurCache");
    logger.debug('Verified saved cache:', savedCache);
  } catch (error) {
    logger.error('Error saving imgur cache:', error);
  }
}

// Calculate file hash using nsICryptoHash
function calculateFileHash(filePath: string): string {
  const file = Components.classes['@mozilla.org/file/local;1']
               .createInstance(Components.interfaces.nsIFile);
  file.initWithPath(filePath);

  const istream = Components.classes['@mozilla.org/network/file-input-stream;1']
                 .createInstance(Components.interfaces.nsIFileInputStream);
  istream.init(file, 0x01, 0o444, 0);

  const ch = Components.classes['@mozilla.org/security/hash;1']
             .createInstance(Components.interfaces.nsICryptoHash);
  ch.init(ch.MD5);
  ch.updateFromStream(istream, -1);
  
  // Convert the hash to hex string
  const hash = ch.finish(false);
  const hexHash = Array.from(hash, (c, i) => hash.charCodeAt(i).toString(16).padStart(2, '0')).join('');
  
  istream.close();
  return hexHash;
}

async function makeRequest(url: string, options: {
  method: string;
  headers: Record<string, string>;
  body: string;
}): Promise<any> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(options.method, url);
    
    Object.entries(options.headers).forEach(([key, value]) => {
      xhr.setRequestHeader(key, value);
    });

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(JSON.parse(xhr.responseText));
      } else {
        reject(new Error(`Request failed: ${xhr.statusText}`));
      }
    };

    xhr.onerror = () => reject(new Error('Network error'));
    xhr.send(options.body);
  });
}

export async function uploadToImgur(filePath: string): Promise<string> {
  try {
    // Load cache
    logger.debug('Loading cache...');
    const cache = loadCache();
    
    // Calculate file hash
    logger.debug('Calculating file hash...');
    const fileHash = calculateFileHash(filePath);
    logger.debug('File hash:', fileHash);
    
    // Check cache
    if (cache[fileHash] && cache[fileHash].url) {
      logger.debug(`Cache hit for ${filePath}, using URL: ${cache[fileHash].url}`);
      return cache[fileHash].url;
    }
    
    logger.debug('Cache miss, uploading to Imgur...');
    // If not in cache, upload to Imgur
    logger.debug(`Uploading ${filePath} to Imgur`);
    
    // Read file using Mozilla file utilities
    logger.debug('Creating file instance...');
    const file = Components.classes['@mozilla.org/file/local;1']
                 .createInstance(Components.interfaces.nsIFile);
    
    logger.debug('Setting file path...');
    file.initWithPath(filePath);
    
    logger.debug('Checking file existence...');
    if (!file.exists()) {
      throw new Error(`File not found: ${filePath}`);
    }
    logger.debug('File exists, size:', file.fileSize);

    logger.debug('Creating input stream...');
    const istream = Components.classes['@mozilla.org/network/file-input-stream;1']
                   .createInstance(Components.interfaces.nsIFileInputStream);
    
    logger.debug('Initializing input stream...');
    istream.init(file, 0x01, 0o444, 0);
    
    logger.debug('Creating binary stream...');
    const bstream = Components.classes['@mozilla.org/binaryinputstream;1']
                   .createInstance(Components.interfaces.nsIBinaryInputStream);
    
    logger.debug('Setting input stream...');
    bstream.setInputStream(istream);
    
    try {
      logger.debug('Reading bytes...');
      const bytes = bstream.readBytes(bstream.available());
      logger.debug('Converting to base64...');
      const base64Image = btoa(bytes);
      logger.debug('Base64 conversion complete, length:', base64Image.length);

      logger.debug('Making request to Imgur...');
      const data = await makeRequest('https://api.imgur.com/3/image', {
        method: 'POST',
        headers: {
          'Authorization': `Client-ID ${IMGUR_CLIENT_ID}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          image: base64Image,
          type: 'base64'
        })
      });

      logger.debug('Imgur request complete');
      if (!data?.data?.link) {
        logger.error('Invalid response from Imgur:', data);
        throw new Error('Invalid response from Imgur');
      }
      
      const imgurUrl = data.data.link;
      logger.debug('Got Imgur URL:', imgurUrl);
      
      // Update cache
      logger.debug('Updating cache...');
      cache[fileHash] = {
        url: imgurUrl,
        timestamp: Date.now()
      };
      saveCache(cache);
      logger.debug('Cache updated with new URL');
      
      return imgurUrl;
    } finally {
      logger.debug('Closing streams...');
      try { bstream.close(); } catch (e) { logger.error('Error closing bstream:', e); }
      try { istream.close(); } catch (e) { logger.error('Error closing istream:', e); }
      logger.debug('Streams closed');
    }
  } catch (error) {
    logger.error('Error in uploadToImgur:', error);
    throw error;
  }
}

export {};
