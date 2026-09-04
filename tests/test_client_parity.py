import re
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
HOST_HTML = (PROJECT_ROOT / '主控台' / '主控台.html').read_text(encoding='utf-8')
HOST_JS = (PROJECT_ROOT / '主控台' / 'app.js').read_text(encoding='utf-8')
HOST_CSS = (PROJECT_ROOT / '主控台' / 'style.css').read_text(encoding='utf-8')
PLAYER_HTML = (PROJECT_ROOT / '主控台' / '玩家.html').read_text(encoding='utf-8')
DICE_JS = (PROJECT_ROOT / '骰子动画.js').read_text(encoding='utf-8')


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
        self.assertIn('adaptive20', host_version.group(1))

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
        self.assertEqual(attribute_values(PLAYER_HTML, 'data-player-workspace-tab'), {
            'room', 'tools', 'draw', 'resources',
        })
        self.assertEqual(attribute_values(PLAYER_HTML, 'data-player-workspace'), {
            'room', 'tools', 'draw', 'resources',
        })
        self.assertEqual(attribute_values(PLAYER_HTML, 'data-player-detail-tab'), {
            'status', 'tactics', 'notes',
        })
        self.assertEqual(attribute_values(PLAYER_HTML, 'data-player-detail-panel'), {
            'status', 'tactics', 'notes',
        })
        self.assertIn('function activatePlayerWorkspace(', PLAYER_HTML)
        self.assertIn('function activatePlayerDetailTab(', PLAYER_HTML)

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
        self.assertIn('faceTexture(highlighted, faceLength, faceLabel, skin)', DICE_JS)
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

    def test_map_grid_and_visual_layer_order_match(self):
        for source in (HOST_JS, PLAYER_HTML):
            self.assertIn('rgba(255,255,255,.78)', source.replace(' ', ''))
            self.assertIn('rgba(0,0,0,.16)', source.replace(' ', ''))
        for source in (HOST_CSS, PLAYER_HTML):
            compact = re.sub(r'\s+', '', source)
            self.assertIn('#spell-range-canvas{z-index:1;', compact)
            self.assertIn('#turn-path-canvas{z-index:2;', compact)
            self.assertIn('#doodle-canvas{', compact)
            self.assertIn('z-index:3;', compact)
        self.assertIn("${streamInfo.readyCount || 0} 人已准备", HOST_JS)

    def test_rest_transition_is_broadcast_and_rendered_on_both_clients(self):
        self.assertIn("Object.freeze({ short: 2200, long: 4400 })", HOST_JS)
        self.assertIn("op: 'restTransition'", HOST_JS)
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

    def test_mounted_tokens_have_link_badges_and_player_pair_details(self):
        for source in (HOST_CSS, PLAYER_HTML):
            block = re.search(r'\.mount-chain-badge\s*\{([^}]+)\}', source)
            self.assertIsNotNone(block)
            css = re.sub(r'\s+', '', block.group(1))
            self.assertIn('left:-3px', css)
            self.assertIn('top:-3px', css)
            self.assertIn('z-index:7', css)
        self.assertIn("chainBadge.className = 'mount-chain-badge'", HOST_JS)
        self.assertIn("chain.className='mount-chain-badge'", PLAYER_HTML)
        self.assertIn('id="detail-mounted-chain"', PLAYER_HTML)
        self.assertIn('function mountedDetailPair(', PLAYER_HTML)
        self.assertIn("mountedDetailUnitButton(pair.rider,'玩家')", PLAYER_HTML)
        self.assertIn("mountedDetailUnitButton(pair.mount,'坐骑')", PLAYER_HTML)

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


if __name__ == '__main__':
    unittest.main()
