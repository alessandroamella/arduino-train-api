import axios, { isAxiosError } from 'axios';
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import {
  filter,
  includes,
  isArray,
  isEmpty,
  round,
  startCase,
  take,
  toInteger,
  toUpper,
  trim,
} from 'lodash';
import NodeCache from 'node-cache';

const cache = new NodeCache();

type Departure = {
  type: string;
  destination: string;
  departureTime: string;
  delay: string;
};

// Load environment variables from .env file
dotenv.config();

// Initialize the Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Use middlewares
app.use(cors()); // Enable Cross-Origin Resource Sharing
app.use(express.json()); // To parse JSON bodies

/**
 * Helper function to format a timestamp into a "HH:mm" string.
 * This is useful for display on small screens.
 */
const formatTime = (timestamp: number) => {
  return new Date(timestamp).toLocaleTimeString('it-IT', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Rome',
  });
};

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
      temperature: `${round(temp, 1)}^C`, // Round to 1 decimal place
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
app.get('/departures/:stationCode', async (req, res) => {
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
    time: string | null;
    weather: { temperature: string };
    toModena: Departure[];
    toBologna: Departure[];
  }>(cacheKey);

  if (cachedDepartures) {
    console.log(`Using cached departures for station: ${stationCode}`);
    // Apply limit if specified
    return res.status(200).json({
      ...cachedDepartures,
      toModena:
        maxResults > 0
          ? take(cachedDepartures.toModena, maxResults)
          : cachedDepartures.toModena,
      toBologna:
        maxResults > 0
          ? take(cachedDepartures.toBologna, maxResults)
          : cachedDepartures.toBologna,
    });
  }

  // The API URL used in your original code to get the departure board
  const viaggiatrenoURL = `http://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno/partenze/${stationCode}/${new Date()}`;

  console.log(
    `Fetching departures for station: ${stationCode}, URL: ${viaggiatrenoURL}`,
  );

  try {
    // Make the request to the Viaggiatreno API
    const { data: rawTrains } = await axios.get(viaggiatrenoURL);

    // Check if the response is a valid array
    if (!isArray(rawTrains)) {
      console.error('Invalid data received from Viaggiatreno API:', rawTrains);
      // This can happen if the station code is wrong or the API has no data
      return res.json([]); // Return an empty array for simplicity
    }

    // Define destination groups
    const destinationGroups = {
      toModena: [
        'MILANO CENTRALE',
        'MODENA',
        'GENOVA BRIGNOLE',
        'PARMA',
        'PIACENZA',
      ],
      toBologna: ['BOLOGNA CENTRALE', 'ANCONA', 'RIMINI', 'PESARO'],
    };

    // Process the raw data to create the simple JSON format for the Arduino
    const simplifiedTrains: Departure[] = rawTrains
      .filter(
        // solo treni che devono ancora partire
        (e) => e.orarioPartenza >= Date.now(),
      )
      .map((train) => ({
        // Type and number, e.g., "REG 12345"
        type: train.compNumeroTreno,
        // Final destination of the train, remove Centrale, format nicely
        destination: startCase(train.destinazione.toLowerCase()).split(' ')[0],
        // Scheduled departure time, formatted as "HH:mm"
        departureTime: formatTime(train.orarioPartenza),
        // Current delay in minutes
        delay: (train.ritardo > 0
          ? `+${train.ritardo}`
          : train.ritardo
        ).toString(),
      }));

    // Separate trains by direction using groupBy or partition
    const filterByDestinations = (destinations: string[]) =>
      filter(simplifiedTrains, (train) =>
        includes(destinations, toUpper(trim(train.destination))),
      );

    const trainsToModena = filterByDestinations(destinationGroups.toModena);
    const trainsToBologna = filterByDestinations(destinationGroups.toBologna);

    // Prepare response with full data
    const response = {
      time: formatTime(Date.now()),
      weather: await getWeather('Bologna'),
      toModena: trainsToModena,
      toBologna: trainsToBologna,
    };

    // Cache for 1 minute (60 seconds)
    cache.set(cacheKey, response, 60);
    console.log(`Cached departures for station: ${stationCode}`);

    // Apply limit if specified and send response
    return res.status(200).json({
      ...response,
      toModena:
        maxResults > 0 ? take(trainsToModena, maxResults) : trainsToModena,
      toBologna:
        maxResults > 0 ? take(trainsToBologna, maxResults) : trainsToBologna,
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
app.listen(PORT, () => {
  console.log(`Server is listening on http://localhost:${PORT}`);
});
