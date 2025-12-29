<?php
ini_set('display_errors', 1);
ini_set('display_startup_errors', 1);
error_reporting(E_ALL);
header("Content-Type: application/json");

$dir = __DIR__ . "/rooms";
$TTL = 1800; // 30 minutes

function is_expired($created, $ttl_seconds) {
  return !is_int($created) || $created <= 0 || $created < (time() - $ttl_seconds);
}

function rand_code() {
  return str_pad(strval(random_int(0, 999999)), 6, "0", STR_PAD_LEFT);
}

// Ensure rooms dir exists
if (!is_dir($dir)) {
  if (!mkdir($dir, 0755, true)) {
    http_response_code(500);
    echo json_encode(["ok"=>false, "error"=>"Failed to create rooms directory", "path"=>$dir]);
    exit;
  }
}
if (!is_writable($dir)) {
  http_response_code(500);
  echo json_encode(["ok"=>false, "error"=>"Rooms directory not writable", "path"=>$dir]);
  exit;
}

/**
 * Step 2: Best-effort garbage collection.
 * Deletes expired (or corrupt) room files even if nobody touches them again.
 * Runs randomly to avoid work on every request.
 */
if (random_int(1, 100) <= 5) { // 5% chance
  foreach (glob($dir . "/*.json") as $file) {
    $raw = @file_get_contents($file);
    if ($raw === false || $raw === "") { @unlink($file); continue; }

    $room = json_decode($raw, true);
    if (!is_array($room)) { @unlink($file); continue; }

    $created = $room["created"] ?? 0;
    if (is_expired($created, $TTL)) {
      @unlink($file);
    }
  }
}

// Create a fresh room
for ($i = 0; $i < 20; $i++) {
  $code = rand_code();
  $roomFile = $dir . "/" . $code . ".json";

  if (!file_exists($roomFile)) {
    $room = ["created"=>time(), "offer"=>null, "answer"=>null];
    $ok = file_put_contents($roomFile, json_encode($room), LOCK_EX);
    if ($ok === false) {
      http_response_code(500);
      echo json_encode(["ok"=>false, "error"=>"Failed to write room file", "file"=>$roomFile]);
      exit;
    }
    echo json_encode(["ok"=>true, "code"=>$code]);
    exit;
  }
}

http_response_code(500);
echo json_encode(["ok"=>false, "error"=>"Could not create room (too many collisions)"]);
