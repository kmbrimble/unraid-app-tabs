<?php
/**
 * Stop every App Tabs console ttyd (used by the .plg remove block, so removing the plugin leaves no terminal server
 * behind). Never starts anything. Always exits 0: it must not fail an uninstall.
 */

declare(strict_types=1);

require_once __DIR__ . '/tabs.php';

if (PHP_SAPI === 'cli' && isset($_SERVER['SCRIPT_FILENAME']) && realpath($_SERVER['SCRIPT_FILENAME']) === __FILE__) {
    try {
        echo 'app.tabs: stopped ' . apptabs_console_reap([]) . " console terminal server(s)\n";
    } catch (\Throwable $e) {
        echo 'app.tabs: could not stop console terminal servers: ' . $e->getMessage() . "\n";
    }
}
