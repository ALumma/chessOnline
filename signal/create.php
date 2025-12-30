<?php
ini_set('display_errors', 1);
ini_set('display_startup_errors', 1);
error_reporting(E_ALL);
header("Content-Type: application/json");

$dir = __DIR__ . "/rooms";
$TTL = 300; // 5 minutes

function is_expired_ts($ts, $ttl_seconds) {
  if (!is_numeric($ts)) return true;
  $ts = (int)$ts;
  return ($ts <= 0) || ($ts < (time() - $ttl_seconds));
}

function rand_code() {
  return str_pad((string)random_int(0, 999999), 6, "0", STR_PAD_LEFT);
}

// Ensure rooms dir exists and is writable
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

/* -----------------------
   GC: run EVERY time
------------------------ */
$gc_ran = true;
$gc_scanned = 0;
$gc_deleted = 0;

$files = glob($dir . "/*.json");
if ($files !== false) {
  foreach ($files as $file) {
    $gc_scanned++;

    $raw = @file_get_contents($file);
    if ($raw === false || $raw === "") {
      @unlink($file);
      $gc_deleted++;
      continue;
    }

    $room = json_decode($raw, true);
    if (!is_array($room)) {
      @unlink($file);
      $gc_deleted++;
      continue;
    }

    $created = $room["created"] ?? null;

    // If created missing/weird, fall back to file modification time
    if (!is_numeric($created)) {
      $created = @filemtime($file);
    }

    if (is_expired_ts($created, $TTL)) {
      @unlink($file);
      $gc_deleted++;
    }
  }
}

/* -----------------------
   Create a new room
------------------------ */
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

    echo json_encode([
      "ok"=>true,
      "code"=>$code,
      "gc_ran"=>$gc_ran,
      "gc_scanned"=>$gc_scanned,
      "gc_deleted"=>$gc_deleted
    ]);
    exit;
  }
}

http_response_code(500);
echo json_encode([
  "ok"=>false,
  "error"=>"Could not create room (too many collisions)",
  "gc_ran"=>$gc_ran,
  "gc_scanned"=>$gc_scanned,
  "gc_deleted"=>$gc_deleted
]);
