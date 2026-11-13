<?php
// Test helper: prints apptabs_render_tab($argv[1]) (APPTABS_* env points it at a temp tree).
require __DIR__ . '/../plugin/include/tabpage.php';
apptabs_render_tab($argv[1] ?? '');
