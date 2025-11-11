/* eslint-disable no-console */
require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const Fuse = require('fuse.js');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ACCESS_CODE = '22170313';
const DATA_SECRET = process.env.DATA_SECRET;

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is not defined in the environment. Please add it to the .env file.');
  process.exit(1);
}

if (!DATA_SECRET) {
  console.error('DATA_SECRET is not defined in the environment. Please add it to the .env file.');
  process.exit(1);
}

let secretBuffer;
try {
  secretBuffer = Buffer.from(DATA_SECRET, 'base64');
} catch (error) {
  console.error('Failed to decode DATA_SECRET from base64. Please ensure it is a valid base64 string.');
  process.exit(1);
}

if (secretBuffer.length !== 32) {
  console.error('DATA_SECRET must decode to exactly 32 bytes. Regenerate it with `openssl rand -base64 32`.');
  process.exit(1);
}

const ENCRYPTED_DATA_PATH = path.resolve(__dirname, '../data/encrypted_clients.json');
const AUTH_USERS_PATH = path.resolve(__dirname, '../authorized_users.json');

let clients = [];
let fuse = null;
let authorizedUsers = new Set();

async function ensureAuthFile() {
  try {
    await fsPromises.access(AUTH_USERS_PATH, fs.constants.F_OK);
  } catch (err) {
    if (err.code === 'ENOENT') {
      await fsPromises.writeFile(AUTH_USERS_PATH, JSON.stringify([], null, 2), 'utf-8');
    } else {
      throw err;
    }
  }
}

async function loadAuthorizedUsers() {
  await ensureAuthFile();

  try {
    const data = await fsPromises.readFile(AUTH_USERS_PATH, 'utf-8');
    const ids = JSON.parse(data);
    if (Array.isArray(ids)) {
      authorizedUsers = new Set(ids.map((id) => id.toString()));
    } else {
      authorizedUsers = new Set();
    }
  } catch (error) {
    console.error('Failed to read authorized users file:', error);
    authorizedUsers = new Set();
  }
}

async function addAuthorizedUser(userId) {
  const normalizedId = userId.toString();
  if (authorizedUsers.has(normalizedId)) {
    return;
  }

  authorizedUsers.add(normalizedId);
  try {
    await fsPromises.writeFile(
      AUTH_USERS_PATH,
      JSON.stringify(Array.from(authorizedUsers), null, 2),
      'utf-8',
    );
  } catch (error) {
    console.error('Failed to update authorized users file:', error);
  }
}

function normalizeCell(value) {
  if (value === undefined || value === null) {
    return '';
  }
  return String(value).trim();
}

function decryptClientsPayload() {
  try {
    if (!fs.existsSync(ENCRYPTED_DATA_PATH)) {
      console.warn(`Encrypted data file not found at ${ENCRYPTED_DATA_PATH}. Run "npm run export-data" to generate it.`);
      return [];
    }

    const raw = fs.readFileSync(ENCRYPTED_DATA_PATH, 'utf-8');
    const payload = JSON.parse(raw);
    const { iv, data, tag } = payload;

    if (!iv || !data || !tag) {
      throw new Error('Invalid encrypted payload structure.');
    }

    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      secretBuffer,
      Buffer.from(iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(tag, 'base64'));

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(data, 'base64')),
      decipher.final(),
    ]);

    const parsed = JSON.parse(decrypted.toString('utf-8'));

    if (!Array.isArray(parsed)) {
      throw new Error('Decrypted payload is not an array.');
    }

    return parsed.map((entry) => ({
      name: normalizeCell(entry.name),
      manager: normalizeCell(entry.manager),
      code: normalizeCell(entry.code),
    })).filter((entry) => entry.name);
  } catch (error) {
    console.error('Failed to decrypt client data:', error.message);
    return [];
  }
}

function loadClients() {
  const decryptedClients = decryptClientsPayload();
  clients = decryptedClients;

  if (clients.length) {
    fuse = new Fuse(clients, {
      includeScore: true,
      threshold: 0.35,
      ignoreLocation: true,
      keys: [
        {
          name: 'name',
          weight: 0.7,
        },
        {
          name: 'manager',
          weight: 0.2,
        },
        {
          name: 'code',
          weight: 0.1,
        },
      ],
    });

    console.log(`Loaded ${clients.length} clients from encrypted storage.`);
  } else {
    fuse = null;
    console.warn('Client list is empty. Ensure encrypted data is generated and accessible.');
  }
}

function scheduleDataReload() {
  const dataDir = path.dirname(ENCRYPTED_DATA_PATH);

  if (!fs.existsSync(dataDir)) {
    console.warn(`Data directory not found at ${dataDir}. Skipping data watcher.`);
    clients = [];
    return;
  }

  let reloadTimeout = null;

  fs.watch(dataDir, { persistent: false }, (eventType, filename) => {
    if (!filename) {
      return;
    }

    const fullPath = path.resolve(dataDir, filename);
    if (fullPath !== ENCRYPTED_DATA_PATH) {
      return;
    }

    if (reloadTimeout) {
      clearTimeout(reloadTimeout);
    }
    reloadTimeout = setTimeout(() => {
      console.log('Detected update in encrypted data. Reloading clients...');
      loadClients();
    }, 500);
  });
}

function formatResult(resultItems) {
  if (!resultItems.length) {
    return 'Совпадений не найдено. Попробуйте уточнить запрос.';
  }

  const header = 'Нашёл следующие совпадения:';
  const lines = resultItems.map((item, index) => {
    const { name, manager, code } = item;
    return `${index + 1}. Клиент: ${name || '—'}\n   Менеджер: ${manager || '—'}\n   Код: ${code || '—'}`;
  });

  return [header, ...lines].join('\n\n');
}

function fallbackSearch(query) {
  const loweredQuery = query.toLowerCase();
  return clients
    .filter(
      ({ name, manager, code }) =>
        name.toLowerCase().includes(loweredQuery)
        || manager.toLowerCase().includes(loweredQuery)
        || code.toLowerCase().includes(loweredQuery),
    )
    .slice(0, 5);
}

function findMatches(query) {
  if (!query.trim()) {
    return [];
  }

  if (!fuse) {
    return fallbackSearch(query);
  }

  const fuseResults = fuse.search(query, { limit: 5 });
  if (fuseResults.length > 0) {
    return fuseResults.map((result) => result.item);
  }

  return fallbackSearch(query);
}

function handleUnauthorizedMessage(bot, chatId, text) {
  if (text.trim() === ACCESS_CODE) {
    addAuthorizedUser(chatId)
      .then(() => {
        bot.sendMessage(
          chatId,
          'Доступ открыт! Отправьте название клиента, менеджера или код, чтобы найти совпадения.',
        );
      })
      .catch((error) => {
        console.error('Error while saving authorized user:', error);
        bot.sendMessage(chatId, 'Произошла ошибка при сохранении доступа. Попробуйте ещё раз позже.');
      });
    return;
  }

  bot.sendMessage(
    chatId,
    'Для доступа к боту отправьте код доступа. После подтверждения вы сможете искать клиентов.',
  );
}

function handleSearchMessage(bot, chatId, query) {
  if (!query.trim()) {
    bot.sendMessage(chatId, 'Пожалуйста, отправьте запрос для поиска.');
    return;
  }

  const matches = findMatches(query);
  const response = formatResult(matches);
  bot.sendMessage(chatId, response);
}

async function bootstrap() {
  await loadAuthorizedUsers();
  loadClients();
  scheduleDataReload();

  const bot = new TelegramBot(BOT_TOKEN, { polling: true });

  bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id.toString();
    if (authorizedUsers.has(chatId)) {
      bot.sendMessage(
        chatId,
        'Рады снова видеть! Отправьте запрос с названием клиента, а я найду ближайшие совпадения.',
      );
      return;
    }

    bot.sendMessage(
      chatId,
      'Привет! Чтобы получить доступ к поиску, отправьте код доступа. После этого сможете искать клиентов.',
    );
  });

  bot.on('message', (msg) => {
    const chatId = msg.chat.id.toString();
    const text = msg.text || '';

    // Ignore messages that the bot sends itself or any non-text messages.
    if (!text) {
      return;
    }

    if (!authorizedUsers.has(chatId)) {
      handleUnauthorizedMessage(bot, chatId, text);
      return;
    }

    if (text.startsWith('/')) {
      // Handle additional commands in the future.
      if (text === '/reload') {
        loadClients();
        bot.sendMessage(chatId, 'Перезагрузил данные клиентов.');
        return;
      }

      bot.sendMessage(chatId, 'Неизвестная команда. Просто отправьте запрос для поиска клиента.');
      return;
    }

    handleSearchMessage(bot, chatId, text);
  });

  bot.on('polling_error', (error) => {
    console.error('Polling error:', error.code, error.response?.body || error.message);
  });

  console.log('Telegram bot is up and running.');
}

bootstrap().catch((error) => {
  console.error('Failed to start the bot:', error);
  process.exit(1);
});


