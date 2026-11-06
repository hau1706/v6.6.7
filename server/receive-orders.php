<?php
declare(strict_types=1);

/**
 * AutoPick Pro order-response receiver.
 * Deploy this file at https://phau.io.vn/receive-orders.php.
 *
 * Before enabling upload in the app, replace the placeholder below with a
 * random secret of at least 32 characters and enter the same value in the app.
 * The original API JSON is stored OUTSIDE DOCUMENT_ROOT where possible and
 * atomically replaces the previous response file.
 */
const AUTOPICK_UPLOAD_TOKEN = 'REPLACE_WITH_A_LONG_RANDOM_SECRET_AT_LEAST_32_CHARS';
const MAX_BODY_BYTES = 8 * 1024 * 1024;

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, private, max-age=0');
header('X-Content-Type-Options: nosniff');

function reply(int $status, array $payload): void {
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST');
    reply(405, ['ok' => false, 'error' => 'method_not_allowed']);
}

if (AUTOPICK_UPLOAD_TOKEN === 'REPLACE_WITH_A_LONG_RANDOM_SECRET_AT_LEAST_32_CHARS'
    || strlen(AUTOPICK_UPLOAD_TOKEN) < 32) {
    reply(503, ['ok' => false, 'error' => 'receiver_not_configured']);
}

$providedToken = (string)($_SERVER['HTTP_X_AUTOPICK_TOKEN'] ?? '');
if ($providedToken === '' || !hash_equals(AUTOPICK_UPLOAD_TOKEN, $providedToken)) {
    reply(401, ['ok' => false, 'error' => 'unauthorized']);
}

$contentType = strtolower((string)($_SERVER['CONTENT_TYPE'] ?? ''));
if ($contentType !== '' && strpos($contentType, 'application/json') !== 0) {
    reply(415, ['ok' => false, 'error' => 'content_type_must_be_json']);
}

$contentLength = isset($_SERVER['CONTENT_LENGTH']) ? (int)$_SERVER['CONTENT_LENGTH'] : 0;
if ($contentLength > MAX_BODY_BYTES) {
    reply(413, ['ok' => false, 'error' => 'payload_too_large']);
}

$raw = file_get_contents('php://input');
if (!is_string($raw) || $raw === '') {
    reply(400, ['ok' => false, 'error' => 'empty_body']);
}
if (strlen($raw) > MAX_BODY_BYTES) {
    reply(413, ['ok' => false, 'error' => 'payload_too_large']);
}

try {
    $decoded = json_decode($raw, false, 512, JSON_THROW_ON_ERROR);
} catch (JsonException $e) {
    reply(400, ['ok' => false, 'error' => 'invalid_json']);
}

if (!is_object($decoded) || !isset($decoded->data) || !is_object($decoded->data)) {
    reply(422, ['ok' => false, 'error' => 'expected_success_response_with_non_empty_orders']);
}
$apiCode = isset($decoded->code) ? (string)$decoded->code : '';
$orders = $decoded->data->orders ?? null;
if ($apiCode !== '0' || !is_array($orders) || count($orders) === 0) {
    reply(422, ['ok' => false, 'error' => 'expected_success_response_with_non_empty_orders']);
}

// Keep this file away from the public web directory where standard hosting layouts permit it.
$documentRoot = realpath((string)($_SERVER['DOCUMENT_ROOT'] ?? ''));
$baseDirectory = $documentRoot !== false ? dirname($documentRoot) : dirname(__DIR__);
$storageDirectory = $baseDirectory . DIRECTORY_SEPARATOR . 'autopick-private-data';
if (!is_dir($storageDirectory) && !@mkdir($storageDirectory, 0700, true) && !is_dir($storageDirectory)) {
    reply(500, ['ok' => false, 'error' => 'storage_directory_unavailable']);
}
@chmod($storageDirectory, 0700);

$destination = $storageDirectory . DIRECTORY_SEPARATOR . 'orders-latest.json';
$tempPath = @tempnam($storageDirectory, 'orders-');
if ($tempPath === false) {
    reply(500, ['ok' => false, 'error' => 'temporary_file_unavailable']);
}

$written = @file_put_contents($tempPath, $raw, LOCK_EX);
if ($written !== strlen($raw)) {
    @unlink($tempPath);
    reply(500, ['ok' => false, 'error' => 'write_failed']);
}
@chmod($tempPath, 0600);
if (!@rename($tempPath, $destination)) {
    @unlink($tempPath);
    reply(500, ['ok' => false, 'error' => 'replace_failed']);
}
@chmod($destination, 0600);

reply(200, [
    'ok' => true,
    'saved' => true,
    'overwrote_previous' => true,
    'order_count' => count($orders),
    'bytes' => strlen($raw),
    'updated_at' => gmdate('c')
]);
