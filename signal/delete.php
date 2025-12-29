<?php
ini_set('log_errors', 1);
ini_set('error_log', __DIR__ . '/php_error.log');
error_reporting(E_ALL);
header("Content-Type: application/json");

$dir = __DIR__ . "/rooms";
$code = $_GET["code"] ?? $_POST["code"] ?? "";

if (!preg_match('/^\d{6}$/', $code)) {
  http_response_code(400);
  echo json_encode(["ok" => false, "error" => "Invalid code"]);
  exit;
}

$roomFile = $dir . "/" . $code . ".json";

if (!file_exists($roomFile)) {
  echo json_encode(["ok" => true, "deleted" => false]);
  exit;
}

if (@unlink($roomFile)) {
  echo json_encode(["ok" => true, "deleted" => true]);
  exit;
}

http_response_code(500);
echo json_encode(["ok" => false, "error" => "Failed to delete room file"]);
