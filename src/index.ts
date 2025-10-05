import axios, { isAxiosError } from 'axios';
import cors from 'cors';
import dotenv from 'dotenv';
import { cleanEnv, port, str } from 'envalid';
import express from 'express';
import { isArray, isEmpty, round, take, toInteger } from 'lodash';
import NodeCache from 'node-cache';

// Load environment variables from .env file
dotenv.config();

// Validate and clean environment variables
const env = cleanEnv(process.env, {
  NODE_ENV: str({
    choices: ['development', 'production', 'test'],
    default: 'development',
  }),
  OPENWEATHER_API_KEY: str(),
  PORT: port({ default: 3000 }),
  API_KEY: str({ default: '' }),
});

// Create a cache instance
const cache = new NodeCache();

// Define the Departure type
type Departure = {
  type: string;
  destination: string;
  departureTime: string;
  delay: string;
};

const viaggiatrenoUrlBase =
  'https://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno';

/**
 * Fetch station name for a given station code.
 * First fetches the region, then fetches station details.
 * Caches the result for 24 hours since station names don't change.
 */
const getStationName = async (stationCode: string): Promise<string> => {
  // Check cache first (24 hours TTL)
  const cacheKey = `station_name_${stationCode}`;
  const cachedName = cache.get<string>(cacheKey);

  if (cachedName) {
    console.log(`Using cached station name for ${stationCode}`);
    return cachedName;
  }

  try {
    // First, fetch the region
    const regionURL = `${viaggiatrenoUrlBase}/regione/${stationCode}`;
    const { data: region } = await axios.get<string>(regionURL);

    console.log(`Fetched region for ${stationCode}: ${region}`);

    if (!region || (typeof region !== 'string' && typeof region !== 'number')) {
      throw new Error('Invalid region data received');
    }

    // Then, fetch the station details
    const detailsURL = `${viaggiatrenoUrlBase}/dettaglioStazione/${stationCode}/${region.toString().trim()}`;
    const { data: stationDetails } = await axios.get(detailsURL);

    const stationName = stationDetails?.localita?.nomeLungo;

    if (!stationName || typeof stationName !== 'string') {
      throw new Error('Station name not found in response');
    }

    // Cache for 24 hours (86400 seconds)
    cache.set(cacheKey, stationName, 86400);
    console.log(`Cached station name for ${stationCode}: ${stationName}`);

    return stationName;
  } catch (error) {
    console.error(
      'Error fetching station name:',
      isAxiosError(error) ? error?.response?.data : error,
    );
    // Return station code as fallback
    return stationCode;
  }
};

// Initialize the Express app
const app = express();

// Use middlewares
app.use(cors()); // Enable Cross-Origin Resource Sharing
app.use(express.json()); // To parse JSON bodies

/**
 * Helper function to format a timestamp into a "HH:mm" string.
 * This is useful for display on small screens.
 */
const formatTime = (timestamp: number, includeSeconds = false) => {
  return new Date(timestamp).toLocaleTimeString('it-IT', {
    hour: '2-digit',
    minute: '2-digit',
    second: includeSeconds ? '2-digit' : undefined,
    timeZone: 'Europe/Rome',
  });
};

/**
 * Middleware to check API key if it's configured.
 * If API_KEY is set in environment variables, validates the 'key' query parameter.
 */
const checkApiKey: express.RequestHandler = (req, res, next) => {
  // If no API key is configured, skip the check
  if (!env.API_KEY) {
    return next();
  }

  const { key } = req.query;

  // Check if the provided key matches the configured API key
  if (key !== env.API_KEY) {
    return res.status(401).json({ error: 'Invalid or missing API key.' });
  }

  next();
};

/**
 * Fetch weather data for a given city using OpenWeather API.
 * Caches the result for 5 minutes to reduce API calls.
 */
const getWeather = async (city: string) => {
  // Check cache first (5 minutes TTL)
  const cacheKey = `weather_${city}`;
  const cachedWeather = cache.get(cacheKey);

  if (cachedWeather) {
    console.log(`Using cached weather data for ${city}`);
    return cachedWeather;
  }

  const apiKey = process.env.OPENWEATHER_API_KEY;
  if (!apiKey) {
    throw new Error('OpenWeather API key is not set in environment variables.');
  }

  try {
    const response = await axios.get(
      `https://api.openweathermap.org/data/2.5/weather`,
      {
        params: {
          q: city,
          appid: apiKey,
          units: 'metric',
          lang: 'it',
        },
      },
    );

    const { temp } = response.data.main;
    const weatherDescription = response.data.weather[0].description;

    const weatherData = {
      // Round to 1 decimal place, use Italian decimal comma
      temperature: `${round(temp, 1)}°C`.replace('.', ','),
      description: weatherDescription,
    };

    // Cache for 5 minutes (300 seconds)
    cache.set(cacheKey, weatherData, 300);
    console.log(`Cached weather data for ${city}`);

    return weatherData;
  } catch (error) {
    console.error(
      'Error fetching weather data:',
      isAxiosError(error) ? error?.response?.data : error,
    );
    throw new Error('Failed to fetch weather data from OpenWeather API.');
  }
};

// --- API Endpoint ---
// GET /departures/:stationCode
// Fetches the next departing trains for a given station code.
// Example: /departures/S01700 (for Bologna Centrale)
// Optional query parameter: limit (number of trains to return)
// Example: /departures/S01700?limit=5
app.get('/departures/:stationCode', checkApiKey, async (req, res) => {
  const { stationCode } = req.params;
  const { limit } = req.query;

  if (isEmpty(stationCode)) {
    return res.status(400).json({ error: 'Station code is required.' });
  }

  // Parse the limit parameter, if provided
  const maxResults = toInteger(limit);

  // Validate the limit parameter if provided
  if (limit && (!Number.isFinite(maxResults) || maxResults < 1)) {
    return res.status(400).json({ error: 'Limit must be a positive number.' });
  }

  // Check cache first (1 minute TTL)
  const cacheKey = `departures_${stationCode}`;
  const cachedDepartures = cache.get<{
    stationName: string;
    weather: { temperature: string };
    departures: Departure[];
  }>(cacheKey);

  if (cachedDepartures) {
    console.log(`Using cached departures for station: ${stationCode}`);
    // Apply limit if specified
    return res.status(200).json({
      time: formatTime(Date.now(), true),
      ...cachedDepartures,
      departures:
        maxResults > 0
          ? take(cachedDepartures.departures, maxResults)
          : cachedDepartures.departures,
    });
  }

  console.log(`Fetching departures for station: ${stationCode}`);

  try {
    // Make the request to the Viaggiatreno API
    const viaggiatrenoURL = `${viaggiatrenoUrlBase}/partenze/${stationCode}/${new Date()}`;
    console.log(`Requesting URL: ${viaggiatrenoURL}`);
    const { data: rawTrains } = await axios.get(viaggiatrenoURL);

    // Check if the response is a valid array
    if (!isArray(rawTrains)) {
      console.error('Invalid data received from Viaggiatreno API:', rawTrains);
      // This can happen if the station code is wrong or the API has no data
      return res.json([]); // Return an empty array for simplicity
    }

    // Process the raw data to create the simple JSON format for the Arduino
    const simplifiedTrains: Departure[] = rawTrains
      // opzionalmente, filtra solo treni che devono ancora partire
      // .filter(
      //   (e) => e.orarioPartenza >= Date.now(),
      // )
      .map((train) => ({
        // Type and number, e.g., "REG 12345"
        type: train.compNumeroTreno.replace('REG', 'R'),
        // Final destination of the train, remove Centrale, format nicely
        destination: train.destinazione.split(' ')[0],
        // Scheduled departure time, formatted as "HH:mm"
        departureTime: formatTime(train.orarioPartenza),
        // Current delay in minutes
        delay: (train.ritardo >= 0
          ? `+${train.ritardo}`
          : train.ritardo
        ).toString(),
      }));

    console.log(
      `Fetched ${simplifiedTrains.length} departures for station: ${stationCode}`,
    );

    // Prepare response with full data (without time, which will be added fresh)
    const response = {
      stationName: await getStationName(stationCode),
      weather: await getWeather('Bologna'),
      departures: simplifiedTrains,
    };

    // Cache for 1 minute (60 seconds)
    cache.set(cacheKey, response, 60);
    console.log(`Cached departures for station: ${stationCode}`);

    // Apply limit if specified and send response
    return res.status(200).json({
      time: formatTime(Date.now(), true), // Always use current time
      ...response,
      departures:
        maxResults > 0 ? take(simplifiedTrains, maxResults) : simplifiedTrains,
    });
  } catch (error) {
    console.error(
      'Error fetching train data:',
      isAxiosError(error) ? error?.response?.data : error,
    );
    return res
      .status(500)
      .json({ error: 'Failed to fetch train data from the external API.' });
  }
});

// A simple root endpoint to check if the server is running
app.get('/', (_req, res) => {
  res.send(
    'Train Departures API is running. Use /departures/:stationCode to get data.',
  );
});

// Start the server
app.listen(env.PORT, () => {
  console.log(`Server is listening on http://localhost:${env.PORT}`);
});
