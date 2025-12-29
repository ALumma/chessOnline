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

$code = $_GET["code"] ?? $_POST["code"] ?? "";
if (!preg_match('/^\d{6}$/', $code)) {
  http_response_code(400);
  echo json_encode(["ok"=>false, "error"=>"Invalid code"]);
  exit;
}

$roomFile = $dir . "/" . $code . ".json";

if (!file_exists($roomFile)) {
  echo json_encode(["ok"=>true, "offer"=>null]);
  exit;
}

$raw = @file_get_contents($roomFile);
if ($raw === false || $raw === "") {
  @unlink($roomFile);
  echo json_encode(["ok"=>true, "offer"=>null]);
  exit;
}

$room = json_decode($raw, true);
if (!is_array($room)) {
  @unlink($roomFile);
  echo json_encode(["ok"=>true, "offer"=>null]);
  exit;
}

// TTL cleanup
$created = $room["created"] ?? 0;
if (is_expired($created, $TTL)) {
  @unlink($roomFile);
  echo json_encode(["ok"=>true, "offer"=>null]);
  exit;
}

if ($_SERVER["REQUEST_METHOD"] === "POST") {
  $offer = $_POST["offer"] ?? "";
  if ($offer === "") {
    http_response_code(400);
    echo json_encode(["ok"=>false, "error"=>"Missing offer"]);
    exit;
  }

  $room["offer"] = $offer;

  $ok = file_put_contents($roomFile, json_encode($room), LOCK_EX);
  if ($ok === false) {
    http_response_code(500);
    echo json_encode(["ok"=>false, "error"=>"Failed to write room file"]);
    exit;
  }

  echo json_encode(["ok"=>true]);
  exit;
}

// GET
echo json_encode(["ok"=>true, "offer"=>$room["offer"] ?? null]);
