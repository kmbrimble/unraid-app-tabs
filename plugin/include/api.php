<?php
/**
 * App Tabs: JSON endpoint for the settings app. POST urlencoded only.
 *
 * No explicit CSRF check here, deliberately: webGui/include/local_prepend.php (the global auto_prepend_file) already
 * enforces CSRF on every plugin POST and CONSUMES $_POST['csrf_token'] once it validates, so a second check would
 * reject every legitimate request. The client still has to send the token (app/index.php hands it to the UI).
 *
 * Actions: get (the list, any config error, the generated pages) and save (replace the whole list).
 */

declare(strict_types=1);

require_once __DIR__ . '/tabs.php';

header('Content-Type: application/json');
header('Cache-Control: no-store');

function apptabs_respond(array $body): void
{
    echo json_encode($body);
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    http_response_code(405);
    apptabs_respond(['ok' => false, 'error' => 'App Tabs: POST required']);
}

try {
    $action = $_POST['action'] ?? '';
    switch ($action) {
        case 'get':
            $cfg = apptabs_load();
            apptabs_respond([
                'ok' => true,
                'tabs' => $cfg['tabs'],
                'config_error' => $cfg['error'],
                'config_path' => apptabs_config_path(),
                'pages' => array_map(fn($f) => basename($f, '.page'), apptabs_generated_files()),
                'max_tabs' => APPTABS_MAX_TABS,
                'first_rank' => APPTABS_FIRST_RANK,
            ]);
        // no break: apptabs_respond() exits
        case 'save':
            $raw = $_POST['tabs'] ?? null;
            if (!is_string($raw) || $raw === '') {
                apptabs_respond(['ok' => false, 'error' => 'Nothing to save: the tabs field is missing.']);
            }
            if (strlen($raw) > APPTABS_MAX_JSON) {
                apptabs_respond(['ok' => false, 'error' => 'That list is too large to save.']);
            }
            $decoded = json_decode($raw, true);
            if (!is_array($decoded)) {
                apptabs_respond(['ok' => false, 'error' => 'The tabs field is not valid JSON.']);
            }
            [$list, $errs] = apptabs_normalize($decoded);
            if ($list === null) {
                apptabs_respond(['ok' => false, 'error' => $errs[0]['message'], 'errors' => $errs]);
            }
            [$ok, $msg] = apptabs_save($list);
            apptabs_respond(['ok' => $ok, 'error' => $ok ? null : $msg, 'message' => $msg,
                'pages' => array_map(fn($f) => basename($f, '.page'), apptabs_generated_files())]);
        default:
            apptabs_respond(['ok' => false, 'error' => 'unknown action']);
    }
} catch (\Throwable $e) {
    error_log('app.tabs api: ' . get_class($e) . ': ' . $e->getMessage());
    apptabs_respond(['ok' => false, 'error' => get_class($e) . ': ' . preg_replace('/[\x00-\x1f]/', ' ', $e->getMessage())]);
}
