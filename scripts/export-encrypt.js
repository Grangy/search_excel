/* eslint-disable no-console */
require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const XLSX = require('xlsx');

const DATA_SECRET = process.env.DATA_SECRET;

if (!DATA_SECRET) {
  console.error('DATA_SECRET is not defined in .env. Please add it before running the exporter.');
  process.exit(1);
}

const SECRET_BUFFER = Buffer.from(DATA_SECRET, 'base64');
if (SECRET_BUFFER.length !== 32) {
  console.error('DATA_SECRET must be a 32-byte base64 string. Regenerate it with `openssl rand -base64 32`.');
  process.exit(1);
}

const EXCEL_PATH = path.resolve(__dirname, '../Клиенты.xlsx');
const OUTPUT_PATH = path.resolve(__dirname, '../data/encrypted_clients.json');

function normalizeCell(value) {
  if (value === undefined || value === null) {
    return '';
  }
  return String(value).trim();
}

function readClientsFromExcel() {
  if (!fs.existsSync(EXCEL_PATH)) {
    console.error(`Excel file not found at: ${EXCEL_PATH}`);
    process.exit(1);
  }

  const workbook = XLSX.readFile(EXCEL_PATH, { cellDates: false });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    console.error('Excel workbook does not contain any sheets.');
    process.exit(1);
  }

  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  return rows
    .map((entry) => ({
      name: normalizeCell(entry['Наименование']),
      manager: normalizeCell(entry['Основной менеджер']),
      code: normalizeCell(entry.Код ?? entry['Код']),
    }))
    .filter((entry) => entry.name);
}

async function ensureOutputDirectory() {
  const dir = path.dirname(OUTPUT_PATH);
  await fsPromises.mkdir(dir, { recursive: true });
}

function encryptData(plaintextBuffer) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', SECRET_BUFFER, iv);
  const encrypted = Buffer.concat([cipher.update(plaintextBuffer), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    iv: iv.toString('base64'),
    data: encrypted.toString('base64'),
    tag: authTag.toString('base64'),
  };
}

async function writeEncryptedData(payload) {
  const json = JSON.stringify(payload, null, 2);
  await fsPromises.writeFile(OUTPUT_PATH, json, 'utf-8');
}

async function main() {
  console.log('Reading clients from Excel...');
  const clients = readClientsFromExcel();
  console.log(`Parsed ${clients.length} clients.`);

  const serialized = Buffer.from(JSON.stringify(clients));
  const encryptedPayload = encryptData(serialized);

  await ensureOutputDirectory();
  await writeEncryptedData(encryptedPayload);

  console.log(`Encrypted data saved to ${OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error('Failed to export and encrypt data:', error);
  process.exit(1);
});


