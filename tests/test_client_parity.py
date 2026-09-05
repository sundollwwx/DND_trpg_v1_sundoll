import re
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
HOST_HTML = (PROJECT_ROOT / '主控台' / '主控台.html').read_text(encoding='utf-8')
HOST_JS = (PROJECT_ROOT / '主控台' / 'app.js').read_text(encoding='utf-8')
HOST_CSS = (PROJECT_ROOT / '主控台' / 'style.css').read_text(encoding='utf-8')
PLAYER_HTML = (PROJECT_ROOT / '主控台' / '玩家.html').read_text(encoding='utf-8')
DICE_JS = (PROJECT_ROOT / '骰子动画.js').read_text(encoding='utf-8')
SERVER_PY = (PROJECT_ROOT / '主控台' / '联机服务器.py').read_text(encoding='utf-8')
REST_SCENE_JS = (PROJECT_ROOT / 'asset' / '界面' / '休息动画' / '休息场景.js').read_text(encoding='utf-8')
REST_SCENE_CSS = (PROJECT_ROOT / 'asset' / '界面' / '休息动画' / '休息动画.css').read_text(encoding='utf-8')


def attribute_values(markup, attribute):
    return set(re.findall(rf'{re.escape(attribute)}="([^"]+)"', markup))


def function_body(source, name, next_name):
    match = re.search(
        rf'function\s+{re.escape(name)}\s*\([^)]*\)\s*\{{([\s\S]*?)\n\s*function\s+{re.escape(next_name)}\s*\(',
        source,
    )
    if not match:
        raise AssertionError(f'Function {name} was not found')
    return match.group(1)


class ClientParityTests(unittest.TestCase):
    def test_shared_dice_reactions_and_spell_presets_match(self):
        self.assertEqual(attribute_values(HOST_HTML, 'data-die'), attribute_values(PLAYER_HTML, 'data-die'))
        self.assertEqual(attribute_values(HOST_HTML, 'data-map-reaction'), attribute_values(PLAYER_HTML, 'data-map-reaction'))
        self.assertEqual(attribute_values(HOST_HTML, 'data-spell-shape'), attribute_values(PLAYER_HTML, 'data-spell-shape'))
        self.assertEqual(attribute_values(HOST_HTML, 'data-spell-feet'), attribute_values(PLAYER_HTML, 'data-spell-feet'))
        self.assertEqual(attribute_values(PLAYER_HTML, 'data-spell-feet'), {'15', '30', '60', '90', '120', '180'})

    def test_both_clients_load_the_same_dice_animation_version(self):
        host_version = re.search(r'骰子动画\.js\?v=([^"<]+)', HOST_HTML)
        player_version = re.search(r'骰子动画\.js\?v=([^"<]+)', PLAYER_HTML)
        self.assertIsNotNone(host_version)
        self.assertIsNotNone(player_version)
        self.assertEqual(host_version.group(1), player_version.group(1))
        self.assertIn('face-lock', host_version.group(1))
        self.assertIn('physics-v7', host_version.group(1))
        self.assertIn('continuous-settle-r6', host_version.group(1))
        self.assertIn('uv-handedness-r7', host_version.group(1))
        self.assertIn('result-focus-r8', host_version.group(1))
        self.assertIn('public-skin-r9', host_version.group(1))
        self.assertIn('d20-tilt-r10', host_version.group(1))

    def test_player_private_rolls_stay_local_and_public_rolls_share_skin(self):
        self.assertEqual(attribute_values(PLAYER_HTML, 'data-dice-visibility'), {'public', 'private'})
        player_roll = function_body(PLAYER_HTML, 'roll', 'addRoll')
        self.assertIn("const isPublic=diceVisibility==='public'", player_roll)
        self.assertIn('if(!isPublic)return', player_roll)
        self.assertIn("skin,visibility:'public'", player_roll)
        self.assertIn('skin,interrupt:true,visibility:isPublic', player_roll)
        self.assertLess(player_roll.index('if(!isPublic)return'), player_roll.index('requestAction('))
        self.assertIn("skin:a.skin,interrupt:true,visibility:'public'", PLAYER_HTML)
        self.assertIn("skin: a.skin, interrupt: true, visibility: 'public'", HOST_JS)

    def test_public_roll_interrupts_previous_animation_and_d20_is_centered(self):
        self.assertIn('request.opts.interrupt === true && animationActive', DICE_JS)
        self.assertIn('rollQueue.splice(0, rollQueue.length)', DICE_JS)
        self.assertIn("const DICE_SIZE_MULTIPLIER = 1.30", DICE_JS)
        self.assertIn("const numberY = dieKind === 'd20' ? 138 : 132", DICE_JS)
        self.assertIn('const D20_RESULT_TILT_DEGREES = 16', DICE_JS)
        self.assertIn("if (key === 'd20') qFinal.premultiply(d20ResultTilt).normalize()", DICE_JS)
        self.assertIn('faceTexture(highlighted, faceLength, faceLabel, skin, key)', DICE_JS)

    def test_stream_start_button_uses_readable_white_text(self):
        block = re.search(r'\.host-room-actions \.primary\s*\{([^}]+)\}', HOST_CSS)
        self.assertIsNotNone(block)
        css = re.sub(r'\s+', '', block.group(1))
        self.assertIn('color:#fff', css)
        self.assertIn('text-shadow:', css)

    def test_condition_badges_start_at_top_right_above_tokens(self):
        for source in (HOST_CSS, PLAYER_HTML):
            block = re.search(r'\.token-condition-badges\s*\{([^}]+)\}', source)
            self.assertIsNotNone(block)
            css = re.sub(r'\s+', '', block.group(1))
            self.assertIn('right:-2px', css)
            self.assertIn('top:-2px', css)
            self.assertIn('bottom:auto', css)
            self.assertIn('flex-direction:row-reverse', css)
            self.assertIn('z-index:6', css)
        self.assertIn('appendConditionBadges(el, t.conditions, true)', HOST_JS)
        self.assertIn('appendConditionBadges(rd, r.conditions, true)', HOST_JS)
        self.assertIn('appendConditionBadges(el,t.conditions)', PLAYER_HTML)
        self.assertIn('appendConditionBadges(rd,r.conditions)', PLAYER_HTML)
        self.assertIn("condition.visibility === 'gm' ? ' · 仅 GM' : ''", HOST_JS)
        self.assertIn("filter(condition=>condition.visibility!=='gm')", PLAYER_HTML)

    def test_player_sidebars_use_clear_workspace_and_detail_categories(self):
        host_tab_order = re.findall(r'data-workspace-tab="([^"]+)"', HOST_HTML)
        self.assertEqual(host_tab_order, ['units', 'map', 'draw', 'resources', 'room'])
        self.assertEqual(attribute_values(HOST_HTML, 'data-workspace'), {
            'room', 'units', 'map', 'draw', 'resources',
        })
        self.assertIn('id="host-player-list"', HOST_HTML)
        self.assertIn('id="host-room-code"', HOST_HTML)
        self.assertIn('function renderHostRoom(', HOST_JS)
        self.assertIn('renderHostRoom();', HOST_JS)

        player_tab_order = re.findall(r'data-player-workspace-tab="([^"]+)"', PLAYER_HTML)
        self.assertEqual(player_tab_order, ['tools', 'units', 'draw', 'resources', 'room'])
        self.assertLess(PLAYER_HTML.index('<h2>🎲 掷骰</h2>'), PLAYER_HTML.index('<h2>🧭 地图工具</h2>'))
        self.assertEqual(attribute_values(PLAYER_HTML, 'data-player-workspace-tab'), {
            'room', 'units', 'tools', 'draw', 'resources',
        })
        self.assertEqual(attribute_values(PLAYER_HTML, 'data-player-workspace'), {
            'room', 'units', 'tools', 'draw', 'resources',
        })
        self.assertEqual(attribute_values(PLAYER_HTML, 'data-player-detail-tab'), {
            'status', 'tactics', 'notes',
        })
        self.assertEqual(attribute_values(PLAYER_HTML, 'data-player-detail-panel'), {
            'status', 'tactics', 'notes',
        })
        self.assertIn('function activatePlayerWorkspace(', PLAYER_HTML)
        self.assertIn('function activatePlayerDetailTab(', PLAYER_HTML)

    def test_unit_browser_is_unified_and_player_spawn_stays_personal(self):
        self.assertEqual(HOST_HTML.count('class="card unit-browser-card"'), 1)
        self.assertIn('id="unit-library-panel"', HOST_HTML)
        self.assertIn('id="unit-custom-panel"', HOST_HTML)
        self.assertIn('data-unit-source="library"', HOST_HTML)
        self.assertIn('data-unit-source="custom"', HOST_HTML)
        self.assertIn('id="lib-search"', HOST_HTML)
        self.assertIn('id="lib-recent"', HOST_HTML)
        self.assertIn('function renderRecentLibraryPresets(', HOST_JS)
        self.assertIn("main.addEventListener('click', () => placePresetOnMap(p.id))", HOST_JS)
        self.assertIn("workspace === 'units'", HOST_JS)
        self.assertIn("card.classList.contains('unit-browser-card')", HOST_JS)

        self.assertIn('data-player-workspace-tab="units"', PLAYER_HTML)
        self.assertIn('id="player-place-token"', PLAYER_HTML)
        self.assertIn('id="player-token-image"', PLAYER_HTML)
        self.assertIn('iconImg:playerDraftPortrait||null', PLAYER_HTML)
        self.assertIn("op:'spawnToken'", PLAYER_HTML)
        self.assertIn("if(a.op==='spawnToken')", PLAYER_HTML)
        self.assertIn("a.op === 'spawnToken'", HOST_JS)
        self.assertIn('id="player-delete-token"', PLAYER_HTML)
        self.assertIn("op:'deletePlayerToken'", PLAYER_HTML)
        self.assertIn("if(a.op==='deletePlayerToken')", PLAYER_HTML)
        self.assertIn("a.op === 'deletePlayerToken'", HOST_JS)
        self.assertIn('remoteToken?.playerCreated === true', HOST_JS)
        self.assertIn('createdByPlayer: t.playerCreated === true', HOST_JS)
        self.assertNotIn('id="lib-list"', PLAYER_HTML)
        self.assertNotIn('data-unit-source="library"', PLAYER_HTML)

    def test_player_can_dismount_an_owned_rider_and_both_clients_apply_it(self):
        self.assertIn("op:'dismountToken'", PLAYER_HTML)
        self.assertIn("if(a.op==='dismountToken')", PLAYER_HTML)
        self.assertIn("a.op === 'dismountToken'", HOST_JS)
        self.assertIn("PLAYER_DISMOUNT_ACTION = 'dismountToken'", SERVER_PY)
        self.assertIn('function dismountOwnedRider(', PLAYER_HTML)
        self.assertIn('className=\'mounted-detail-dismount\'', PLAYER_HTML)
        self.assertIn('turnPathTransferred', PLAYER_HTML)
        self.assertIn('turnPathTransferred', HOST_JS)

    def test_player_can_mount_an_owned_rider_and_every_surface_applies_it(self):
        self.assertIn("op:'mountToken'", PLAYER_HTML)
        self.assertIn("if(a.op==='mountToken')", PLAYER_HTML)
        self.assertIn("a.op === 'mountToken'", HOST_JS)
        self.assertIn("PLAYER_MOUNT_ACTION = 'mountToken'", SERVER_PY)
        self.assertIn('function mountOwnedRider(', PLAYER_HTML)
        self.assertIn("picker.className='player-mount-picker'", PLAYER_HTML)
        self.assertIn('initiativeEntries', PLAYER_HTML)
        self.assertIn('initiativeEntries', HOST_JS)

    def test_owned_player_tokens_stay_clickable_when_tokens_overlap(self):
        base = re.search(r'\.token\s*\{([^}]+)\}', PLAYER_HTML)
        owned = re.search(r'\.token\.mine\s*\{([^}]+)\}', PLAYER_HTML)
        dragging = re.search(r'\.token\.dragging\s*\{([^}]+)\}', PLAYER_HTML)
        self.assertIsNotNone(base)
        self.assertIsNotNone(owned)
        self.assertIsNotNone(dragging)
        self.assertIn('z-index:0', re.sub(r'\s+', '', base.group(1)))
        self.assertIn('z-index:2', re.sub(r'\s+', '', owned.group(1)))
        self.assertIn('z-index:4', re.sub(r'\s+', '', dragging.group(1)))

    def test_host_has_a_live_player_connection_indicator(self):
        self.assertIn('id="host-connection"', HOST_HTML)
        for state_name in ('off', 'connecting', 'online'):
            self.assertIn(f"'{state_name}'", HOST_JS)
        self.assertIn("ev.type === 'presence'", HOST_JS)
        self.assertIn('已联机 · ${playerCount} 人', HOST_JS)
        self.assertIn('.host-connection[data-state="online"]', HOST_CSS)

    def test_music_library_sync_and_live_tab_audio_are_available_on_both_clients(self):
        for element_id in (
            'btn-bgm-refresh', 'btn-bgm-pick', 'btn-bgm-play', 'bgm-list', 'btn-bgm-live',
        ):
            self.assertIn(f'id="{element_id}"', HOST_HTML)
        self.assertNotIn('id="btn-bgm-bind"', HOST_HTML)
        self.assertIn('function loadProjectMusicLibrary(', HOST_JS)
        self.assertIn('/api/music-library?', HOST_JS)
        self.assertIn('function startLiveAudioBroadcast(', HOST_JS)
        self.assertIn("getDisplayMedia({ video: true, audio: true })", HOST_JS)
        self.assertIn("ev.type === 'webrtcSignal'", HOST_JS)

        for element_id in (
            'player-audio-title', 'player-audio-status', 'player-audio-mute',
            'player-audio-volume', 'player-audio-enable',
        ):
            self.assertIn(f'id="{element_id}"', PLAYER_HTML)
        self.assertIn("fetch('/api/music-state'", PLAYER_HTML)
        self.assertIn("ev.type==='webrtcSignal'", PLAYER_HTML)
        self.assertIn('function applyPlayerWebRtcSignal(', PLAYER_HTML)
        self.assertIn('issuedAt', PLAYER_HTML)

        for marker in (
            "path == '/api/music-library'", "path.startswith('/api/music-stream/')",
            "path == '/api/music-state'", "'/api/webrtc-signal'", 'Accept-Ranges',
        ):
            self.assertIn(marker, SERVER_PY)

    def test_player_can_edit_only_public_conditions_and_host_is_notified(self):
        for element_id in (
            'player-condition-open',
            'player-condition-editor',
            'player-condition-select',
            'player-condition-custom-name',
            'player-condition-turns',
            'player-condition-save',
        ):
            self.assertIn(f'id="{element_id}"', PLAYER_HTML)
        self.assertNotIn('data-player-condition-visibility', PLAYER_HTML)
        self.assertIn("visibility:'public'", PLAYER_HTML)

        apply_conditions = function_body(
            PLAYER_HTML, 'applyPlayerConditions', 'savePlayerCondition'
        )
        self.assertIn('ownedToken(t)', apply_conditions)
        self.assertIn('canActWithToken(t)', apply_conditions)
        self.assertIn('sendPatch(t.id,{conditions:', apply_conditions)
        self.assertIn('dispatchPendingPatch().then', apply_conditions)

        merge = function_body(
            HOST_JS, 'mergePlayerPublicConditions', 'normalizeSpellRange'
        )
        self.assertIn("condition.visibility === 'gm'", merge)
        self.assertIn("visibility: 'public'", merge)
        self.assertIn('return [...privateConditions, ...publicConditions]', merge)
        self.assertIn("Object.prototype.hasOwnProperty.call(p, 'conditions')", HOST_JS)
        self.assertIn('mergePlayerPublicConditions(t.conditions, p.conditions)', HOST_JS)
        self.assertIn("a.actor || '玩家'", HOST_JS)
        self.assertIn('状态效果（${publicCount} 项）', HOST_JS)

    def test_cone_aim_is_a_pointer_drag_and_player_sends_once_on_release(self):
        for hook in ('beginSelectedSpellAim', 'previewSelectedSpellAimAt', 'finishSelectedSpellAim'):
            self.assertIn(f'function {hook}(', HOST_JS)
        for hook in ('beginPlayerSpellAim', 'previewPlayerSpellAimAt', 'finishPlayerSpellAim'):
            self.assertIn(f'function {hook}(', PLAYER_HTML)
        self.assertIn("drag.mode === 'spell-aim'", HOST_JS)
        self.assertIn("drag.kind==='spell-aim'", PLAYER_HTML)
        self.assertIn('setPointerCapture(e.pointerId)', HOST_JS)
        self.assertIn('setPointerCapture(e.pointerId)', PLAYER_HTML)
        preview = function_body(PLAYER_HTML, 'previewPlayerSpellAimAt', 'beginPlayerSpellAim')
        finish = function_body(PLAYER_HTML, 'finishPlayerSpellAim', 'encounter')
        self.assertNotIn('sendPatch(', preview)
        self.assertEqual(finish.count('sendPatch('), 1)
        self.assertIn('按住左键旋转', HOST_JS)
        self.assertIn('按住左键旋转', PLAYER_HTML)

    def test_dice_lock_result_to_world_up_and_report_diagnostics(self):
        self.assertIn('targetVec = worldUp', DICE_JS)
        self.assertNotIn('targetVec = viewDir', DICE_JS)
        self.assertIn('tex.flipY = false', DICE_JS)
        self.assertIn('const screenUpOnTable = new THREE.Vector3(0, 0, -1)', DICE_JS)
        self.assertIn('topLabels:', DICE_JS)
        self.assertIn('topScores:', DICE_JS)
        self.assertIn('faceLockPassed:', DICE_JS)
        self.assertIn('root.dataset.faceLockPassed', DICE_JS)
        self.assertIn('qYaw.multiply(qAlign).normalize()', DICE_JS)
        self.assertIn('function ensureOutwardFace(verts, face)', DICE_JS)
        self.assertIn('poly.faces = poly.faces.map((face) => ensureOutwardFace(poly.verts, face))', DICE_JS)
        self.assertIn('const orientationGuideT = clampNumber(', DICE_JS)
        self.assertIn('d.mesh.quaternion.slerp(d.qFinal, orientationBlend).normalize()', DICE_JS)
        self.assertIn('settleAngularDistances:', DICE_JS)
        self.assertIn('maxSettleFrameAngularSteps:', DICE_JS)
        self.assertIn('continuousSettlePassed:', DICE_JS)
        self.assertIn('root.dataset.continuousSettlePassed', DICE_JS)

    def test_dice_labels_are_baked_into_faces_and_custom_results_stay_exact(self):
        self.assertIn("labelMode: 'face-texture'", DICE_JS)
        self.assertIn('faceTexture(highlighted, faceLength, faceLabel, skin, key)', DICE_JS)
        self.assertIn('faceTexts[res - 1] = String(d.text)', DICE_JS)
        self.assertIn('const a = -(i / n) * Math.PI * 2 - Math.PI / 2', DICE_JS)
        self.assertEqual(DICE_JS.count('const triUv = [[0.12, 0.12], [0.5, 0.92], [0.88, 0.12]]'), 2)
        self.assertNotIn('new THREE.Sprite(', DICE_JS)
        self.assertNotIn('new THREE.SpriteMaterial(', DICE_JS)

    def test_dice_use_shape_contact_height_and_real_d10_geometry(self):
        self.assertIn('function supportHeight(', DICE_JS)
        self.assertIn('groundClearances:', DICE_JS)
        self.assertIn('prepareSettleTargets()', DICE_JS)
        self.assertIn('pentagonalTrapezohedron()', DICE_JS)
        self.assertNotIn('restRatio /= 3', DICE_JS)

    def test_rapid_rolls_are_queued_instead_of_cancelling_each_other(self):
        self.assertIn('MAX_QUEUED_ROLLS', DICE_JS)
        self.assertIn('rollQueue.push(request)', DICE_JS)
        self.assertIn('startNextQueuedRoll', DICE_JS)
        self.assertIn('sundoll-dice-complete', DICE_JS)
        self.assertIn('window.__DICE_HISTORY__', DICE_JS)

    def test_dice_result_waits_for_confirmation_or_three_second_timeout(self):
        self.assertIn('const RESULT_HOLD_MS = 3000', DICE_JS)
        self.assertIn("confirm.className = 'dice-result-confirm'", DICE_JS)
        self.assertIn("finish('manual')", DICE_JS)
        self.assertIn("finish('auto')", DICE_JS)
        self.assertIn("animationPhase = 'closing'", DICE_JS)
        self.assertNotIn("if (animationPhase === 'result') scheduleAdvance(520)", DICE_JS)

    def test_advantage_focus_starts_only_after_settle(self):
        self.assertIn('const inResultFocus = !!mode && elapsed >= settleEnd', DICE_JS)
        self.assertIn('if (inResultFocus) prepareResultFocus()', DICE_JS)
        self.assertIn('applyResultFocus(d, focusT)', DICE_JS)
        self.assertIn("root.dataset.focusStartedAfterSettle = 'true'", DICE_JS)
        self.assertIn('const finalScale = perScale', DICE_JS)
        self.assertIn('preFocusOpacities: diceData.map(() => 1)', DICE_JS)
        self.assertIn('focusApplied:', DICE_JS)

    def test_up_to_twenty_dice_use_adaptive_scale_and_five_column_layout(self):
        self.assertIn('const MAX_ANIMATED_DICE = 20', DICE_JS)
        self.assertIn('Math.min(MAX_ANIMATED_DICE, requestedDisplayCount)', DICE_JS)
        self.assertIn('function adaptiveScaleFactor(N)', DICE_JS)
        self.assertIn('function adaptiveColumns(N)', DICE_JS)
        self.assertIn('return 5;', DICE_JS)
        self.assertIn('maxAnimatedDice: MAX_ANIMATED_DICE', DICE_JS)

    def test_map_grid_is_always_visible_without_toggle_or_fog(self):
        for source in (HOST_JS, PLAYER_HTML):
            compact = source.replace(' ', '')
            self.assertIn('rgba(255,255,255,.78)', compact)
            self.assertIn('rgba(0,0,0,.16)', compact)
            self.assertNotIn('showGrid?', compact)
        for source in (HOST_CSS, PLAYER_HTML):
            compact = re.sub(r'\s+', '', source)
            self.assertIn('#spell-range-canvas{z-index:1;', compact)
            self.assertIn('#turn-path-canvas{z-index:2;', compact)
            self.assertIn('#doodle-canvas{', compact)
            self.assertIn('z-index:3;', compact)
            self.assertNotIn('#fog-canvas', compact)
        self.assertIn('${readyCount} 人已准备', HOST_JS)

    def test_rest_transition_is_broadcast_and_rendered_on_both_clients(self):
        self.assertIn("Object.freeze({ short: 2200, long: 4400 })", HOST_JS)
        self.assertIn("op: 'restTransition'", HOST_JS)
        self.assertIn('scene: scene.id', HOST_JS)
        self.assertIn('SundollRestScenes.get(requestedScene', HOST_JS)
        self.assertIn("$('#btn-time-short-rest').disabled = restAnimationActive", HOST_JS)
        self.assertIn("$('#btn-time-long-rest').disabled = restAnimationActive", HOST_JS)
        take_rest = function_body(HOST_JS, 'takeRest', 'applyWeatherFromInputs')
        self.assertIn("if (e.playMode !== 'free')", take_rest)
        self.assertIn('leaveCombatForFreeMode()', take_rest)
        for element_id in (
            'rest-scene-modal', 'rest-scene-picker-title', 'rest-scene-options',
            'btn-rest-scene-cancel', 'btn-rest-scene-confirm',
        ):
            self.assertIn(f'id="{element_id}"', HOST_HTML)
        self.assertIn('function openRestScenePicker(', HOST_JS)
        self.assertIn("openRestScenePicker('short')", HOST_JS)
        self.assertIn("openRestScenePicker('long')", HOST_JS)
        self.assertIn('rest-scene-option-image', HOST_CSS)
        for element_id in (
            'rest-transition',
            'rest-transition-icon',
            'rest-transition-title',
            'rest-transition-subtitle',
        ):
            self.assertIn(f'id="{element_id}"', PLAYER_HTML)
        self.assertIn("if(a.op==='restTransition'){playRestTransition(a);return;}", PLAYER_HTML)
        self.assertIn("'mapReaction','restTransition'", PLAYER_HTML)
        self.assertIn('fallback=isLong?4400:2200', PLAYER_HTML)
        for markup in (HOST_HTML, PLAYER_HTML):
            self.assertIn('../asset/界面/休息动画/休息场景.js?v=20260905-rest-scenes-v2', markup)
            self.assertIn('../asset/界面/休息动画/休息动画.css?v=20260905-rest-scenes-v2', markup)
        for scene_id in (
            'short-outdoor', 'short-indoor', 'short-dungeon',
            'long-outdoor', 'long-indoor', 'long-shelter',
        ):
            self.assertIn(scene_id, REST_SCENE_JS)
        for image_name in (
            '短休-室外林地.jpg', '短休-室内酒馆.jpg', '短休-地下城.jpg',
            '长休-室外星夜.jpg', '长休-室内旅店.jpg', '长休-风雪避难.jpg',
        ):
            self.assertTrue((PROJECT_ROOT / 'asset' / '界面' / '休息动画' / image_name).is_file())
        self.assertIn('@media (prefers-reduced-motion: reduce)', REST_SCENE_CSS)

    def test_mounted_tokens_skip_map_badges_but_keep_player_pair_details(self):
        self.assertNotIn('mount-chain-badge', HOST_CSS)
        self.assertNotIn('mount-chain-badge', HOST_JS)
        self.assertNotIn('mount-chain-badge', PLAYER_HTML)
        self.assertIn('id="detail-mounted-chain"', PLAYER_HTML)
        self.assertIn('function mountedDetailPair(', PLAYER_HTML)
        self.assertIn("mountedDetailUnitButton(pair.rider,'玩家')", PLAYER_HTML)
        self.assertIn("mountedDetailUnitButton(pair.mount,'坐骑')", PLAYER_HTML)
        tactics_index = PLAYER_HTML.index('data-player-detail-panel="tactics"')
        spell_index = PLAYER_HTML.index('class="field player-spell-range"')
        mount_index = PLAYER_HTML.index('id="detail-mounted-chain"')
        self.assertLess(tactics_index, spell_index)
        self.assertLess(spell_index, mount_index)

    def test_manual_initiative_binds_the_selected_token_and_deduplicates_mounts(self):
        self.assertNotIn('id="init-name"', HOST_HTML)
        for element_id in (
            'init-selected-token',
            'init-selected-icon',
            'init-selected-name',
            'init-selected-meta',
            'init-value',
            'btn-init-add',
        ):
            self.assertIn(f'id="{element_id}"', HOST_HTML)

        upsert = function_body(HOST_JS, 'upsertSelectedInitiativeEntry', 'pruneInitiativeTokenRefs')
        self.assertIn('state.selectedId ? findToken(state.selectedId) : null', upsert)
        self.assertIn('initiativeEntryForToken(e, token)', upsert)
        self.assertIn('entry.tokenId = subject.token.id', upsert)
        self.assertIn('tokenId: subject.token.id', upsert)

        representative = function_body(
            HOST_JS, 'initiativeRepresentativeForSelection', 'reconcileInitiativeEntries'
        )
        self.assertIn('if (token.mountId)', representative)
        self.assertIn('owners.size === 1', representative)
        self.assertIn('owners.size > 1', representative)

        reconcile = function_body(HOST_JS, 'reconcileInitiativeEntries', 'renderInitiativeSelection')
        self.assertIn('linkLegacyNames', reconcile)
        self.assertIn('groupIds.has(candidateToken.id)', reconcile)
        self.assertIn('normalized[duplicateIndex] = keeper', reconcile)
        self.assertIn('未关联棋子', HOST_JS)
        self.assertIn("state.encounter.playMode = 'prepare'", HOST_JS)
        self.assertIn('unlinkedInitiativeEntries', HOST_JS)

    def test_player_turn_permission_uses_the_same_mounted_control_group(self):
        body = function_body(PLAYER_HTML, 'canActWithToken', 'canMoveToken')
        self.assertIn('currentTurnToken()', body)
        self.assertIn('controlsCurrentTurn(current)', body)
        self.assertIn('tokenControlGroup(token).has(current.id)', body)

    def test_player_measurement_snaps_to_intersections_or_centers(self):
        body = function_body(PLAYER_HTML, 'snapMeasurePoint', 'snap')
        self.assertIn('const intersections=', body)
        self.assertIn('const centers=', body)
        self.assertIn("Math.round(p.x/grid-.5)*grid+grid/2", body)
        self.assertIn('Math.hypot(p.x-intersections.x,p.y-intersections.y)', body)
        self.assertIn('方格交点或格心', PLAYER_HTML)

    def test_player_can_undo_or_reset_the_authoritative_turn_path(self):
        for element_id in ('turn-path-actions', 'turn-path-undo', 'turn-path-reset'):
            self.assertIn(f'id="{element_id}"', PLAYER_HTML)
        self.assertIn("runTurnPathAction('turnPathUndo')", PLAYER_HTML)
        self.assertIn("runTurnPathAction('turnPathReset')", PLAYER_HTML)
        player_action = function_body(PLAYER_HTML, 'runTurnPathAction', 'renderMap')
        self.assertIn('tokenId:current.id', player_action)
        self.assertNotIn('tokenId:anchor.id', player_action)
        self.assertIn("a.op==='turnPathUndo'||a.op==='turnPathReset'", PLAYER_HTML)
        self.assertIn("a.op === 'turnPathUndo' || a.op === 'turnPathReset'", HOST_JS)

    def test_host_can_undo_or_reset_any_current_turn_path(self):
        for element_id in ('host-turn-path-actions', 'btn-turn-path-toggle', 'btn-turn-path-undo', 'btn-turn-path-reset'):
            self.assertIn(f'id="{element_id}"', HOST_HTML)
        self.assertIn('function hostTurnPathContext(', HOST_JS)
        self.assertIn('function updateHostTurnPathControls(', HOST_JS)
        host_action = function_body(HOST_JS, 'applyHostTurnPathAction', 'worldTimeNow')
        self.assertIn("op === 'turnPathUndo'", host_action)
        self.assertIn("points.slice(0, -1)", host_action)
        self.assertIn("points.slice(0, 1)", host_action)
        self.assertIn('moveToken(context.anchor.id', host_action)
        self.assertNotIn('.owner', host_action)
        self.assertIn("a.pathMode !== 'replace'", HOST_JS)
        self.assertIn('remoteStreamSeq < latestSeqAtResponse', HOST_JS)
        self.assertIn('remoteStreamSeq > previouslyAppliedSeq && remotePathChanged', HOST_JS)

    def test_host_can_pause_turn_path_recording_without_disabling_turn_movement(self):
        self.assertIn('style.css?v=20260905-m52-always-grid', HOST_HTML)
        self.assertIn('app.js?v=20260905-m52-always-grid', HOST_HTML)
        self.assertIn("HOST_TURN_PATH_RECORDING_KEY = 'sundoll-host-turn-path-recording-v1'", HOST_JS)
        self.assertIn('function setHostTurnPathRecording(', HOST_JS)
        controls = HOST_JS[
            HOST_JS.index('function updateHostTurnPathControls'):
            HOST_JS.index('function applyHostTurnPathAction')
        ]
        self.assertIn("toggle.setAttribute('aria-pressed', String(hostTurnPathRecording))", controls)
        self.assertIn("toggle.textContent = '路径'", controls)
        self.assertIn("'路径记录已开启'", controls)
        self.assertIn('grid-template-columns: repeat(3, minmax(0, 1fr))', HOST_CSS)
        self.assertIn('>路径</button>', HOST_HTML)
        self.assertIn('>回退</button>', HOST_HTML)
        self.assertIn('>重置</button>', HOST_HTML)
        self.assertIn('hostTurnPathRecording && isCurrentTurnToken(mount)', HOST_JS)
        self.assertIn('hostTurnPathRecording && isCurrentTurnToken(token)', HOST_JS)
        self.assertIn("setHostTurnPathRecording(!hostTurnPathRecording)", HOST_JS)
        append = function_body(HOST_JS, 'appendTurnPath', 'hostTurnPathContext')
        self.assertIn('const continuous =', append)
        self.assertIn('sameTurnPoint(previous[previous.length - 1], valid[0])', append)

    def test_turn_actions_are_short_and_share_one_row(self):
        self.assertIn('id="initiative-turn-actions"', HOST_HTML)
        self.assertIn('id="btn-init-next" class="primary" type="button">结束回合</button>', HOST_HTML)
        self.assertIn('id="btn-combat-end" class="danger" type="button">结束战斗</button>', HOST_HTML)
        self.assertIn("$('#initiative-turn-actions').hidden = !inTurn", HOST_JS)
        self.assertIn("$('#btn-init-next').textContent = '结束回合'", HOST_JS)
        self.assertIn("$('#btn-combat-end').addEventListener('click', endCombatFromButton)", HOST_JS)
        self.assertIn('grid-template-columns: repeat(2, minmax(0, 1fr))', HOST_CSS)

    def test_drag_path_distinguishes_a_direct_diagonal_from_an_intentional_corner(self):
        for source in (HOST_JS, PLAYER_HTML):
            self.assertIn('TURN_DIAGONAL_MIN_STEP', source)
            self.assertIn('TURN_DIAGONAL_MAX_STEP', source)
            self.assertIn('TURN_DIAGONAL_INTENT_RATIO', source)
            self.assertIn('function recordTurnDragPoint(', source)
            body = function_body(source, 'recordTurnDragPoint', 'appendTurnPath')
            self.assertIn('firstHorizontal', body)
            self.assertIn('secondVertical', body)
            self.assertIn('rawPoint', body)
            self.assertIn('diagonalCornerIntent', body)
            self.assertIn('directDiagonal', body)
            self.assertIn('points[points.length - 1] = candidate', body.replace('points[points.length-1]', 'points[points.length - 1]'))
        self.assertIn('recordTurnDragPoint(drag,{x:t.x,y:t.y},currentMap.gridSize,state.snap!==false,p)', PLAYER_HTML)
        self.assertIn('recordTurnDragPoint(drag, { x: token.x, y: token.y }, m.gridSize, Boolean(state.snap), { x, y })', HOST_JS)

    def test_mount_group_conditions_decrement_together_on_all_three_surfaces(self):
        host_body = function_body(HOST_JS, 'decrementCurrentTokenConditions', 'returnToCombatPreparationIfEmpty')
        player_body = function_body(PLAYER_HTML, 'decrementCurrentTokenConditions', 'recordTurnDragPoint')
        self.assertIn('tokenControlGroup(token)', host_body)
        self.assertIn('activeTokens().forEach', host_body)
        self.assertIn('tokenControlGroup(token)', player_body)
        self.assertIn('(currentMap.tokens||[]).forEach', player_body)
        self.assertIn('group_ids = token_control_group(state, token)', SERVER_PY)

    def test_empty_initiative_returns_turn_mode_to_preparation(self):
        empty_handler = function_body(HOST_JS, 'returnToCombatPreparationIfEmpty', 'advanceEncounter')
        self.assertIn("e.playMode === 'turn'", empty_handler)
        self.assertIn("e.playMode = 'prepare'", empty_handler)
        self.assertIn('returnToCombatPreparationIfEmpty(e)', HOST_JS)
        self.assertIn("e.worldTime.resumeAfterTurn || wasRunning", HOST_JS)
        self.assertIn("if (e.worldTime.resumeAfterTurn) e.worldTime.runningSince", HOST_JS)
        self.assertIn("e.playMode==='turn'&&(!Array.isArray(e.entries)||!e.entries.length)", PLAYER_HTML)
        self.assertIn("encounter.get('playMode') == 'turn' and not (encounter.get('entries') or [])", SERVER_PY)

    def test_weather_uses_markov_memory_and_server_authority(self):
        for marker in (
            'WEATHER_MARKOV_TRANSITIONS',
            'WIND_MARKOV_TRANSITIONS',
            'MAX_WEATHER_CATCHUP_DAYS',
            'expectedTemperature * 0.65 + previous.temperature * 0.35',
            'for (let day = firstDay; day <= currentDay; day += 1)',
        ):
            self.assertIn(marker, HOST_JS)
        for marker in (
            'WEATHER_MARKOV_TRANSITIONS',
            'WIND_MARKOV_TRANSITIONS',
            'MAX_WEATHER_CATCHUP_DAYS',
            'expected * .65 + previous[\'temperature\'] * .35',
            'for day in range(first_day, current_day + 1)',
            "action['weather'] = dict(generated_weather)",
        ):
            self.assertIn(marker, SERVER_PY)
        self.assertIn("if (a.weather && typeof a.weather === 'object')", HOST_JS)
        self.assertIn("if(a.weather&&typeof a.weather==='object')", PLAYER_HTML)


if __name__ == '__main__':
    unittest.main()
