"use strict";

(() => {
  const section = document.getElementById("puzzle-section");
  if (!section) return;

  const board = section.querySelector("#puzzle-board");
  const movesLabel = section.querySelector("#puzzle-moves");
  const status = section.querySelector("#puzzle-status");
  const shuffleButton = section.querySelector("#puzzle-shuffle");
  if (!board || !movesLabel || !status || !shuffleButton) return;

  const size = 5;
  const count = size * size;
  const blankPiece = count - 1;
  let pieces = [];
  let moves = 0;
  let complete = false;
  let shuffleStreak = 0;
  let lastShuffleTime = null;

  function resetShuffleStreak() {
    shuffleStreak = 0;
    lastShuffleTime = null;
  }

  function adjacent(first, second) {
    const rowDistance = Math.abs(Math.floor(first / size) - Math.floor(second / size));
    const columnDistance = Math.abs((first % size) - (second % size));
    return rowDistance + columnDistance === 1;
  }

  function neighbors(position, previous = -1) {
    return Array.from({ length: count }, (_, index) => index)
      .filter((index) => index !== previous && adjacent(index, position));
  }

  function render() {
    complete = pieces.every((piece, position) => piece === position);
    const blankPosition = pieces.indexOf(blankPiece);

    for (let piece = 0; piece < count; piece += 1) {
      const tile = tiles[piece];
      const position = pieces.indexOf(piece);
      const row = Math.floor(position / size) + 1;
      const column = (position % size) + 1;
      const isBlank = piece === blankPiece && !complete;
      const movable = !complete && !isBlank && adjacent(position, blankPosition);

      tile.dataset.position = String(position);
      tile.style.setProperty("--tile-column", String(position % size));
      tile.style.setProperty("--tile-row", String(Math.floor(position / size)));
      tile.classList.toggle("is-blank", isBlank);
      tile.classList.toggle("is-movable", movable);
      tile.querySelector(".puzzle-number").hidden = isBlank || complete;
      tile.disabled = isBlank || complete;
      tile.setAttribute("aria-disabled", String(!movable));
      tile.setAttribute("aria-hidden", String(isBlank));
      tile.setAttribute("aria-label", isBlank
        ? `第 ${row} 行第 ${column} 列的空位`
        : `第 ${row} 行第 ${column} 列的拼图，原图第 ${Math.floor(piece / size) + 1} 行第 ${(piece % size) + 1} 列`);
    }

    board.classList.toggle("is-complete", complete);
    movesLabel.textContent = `${moves} 步`;
    status.textContent = complete ? "传奇再现！" : "";
  }

  function move(piece) {
    if (complete || piece === blankPiece) return;
    const position = pieces.indexOf(piece);
    const blankPosition = pieces.indexOf(blankPiece);
    if (!adjacent(position, blankPosition)) return;

    resetShuffleStreak();
    [pieces[position], pieces[blankPosition]] = [pieces[blankPosition], pieces[position]];
    moves += 1;
    render();
  }

  function handleShuffle() {
    const now = Date.now();
    const elapsed = lastShuffleTime === null ? Infinity : now - lastShuffleTime;
    shuffleStreak = elapsed >= 0 && elapsed <= 1500 ? shuffleStreak + 1 : 1;
    lastShuffleTime = now;

    if (shuffleStreak === 10) {
      resetShuffleStreak();
      pieces = Array.from({ length: count }, (_, position) => position);
      moves = 0;
      render();
      return;
    }

    shuffle();
  }

  function shuffle() {
    pieces = Array.from({ length: count }, (_, position) => position);
    let blankPosition = blankPiece;
    let previous = -1;

    for (let step = 0; step < 500; step += 1) {
      const choices = neighbors(blankPosition, previous);
      const next = choices[Math.floor(Math.random() * choices.length)];
      [pieces[blankPosition], pieces[next]] = [pieces[next], pieces[blankPosition]];
      previous = blankPosition;
      blankPosition = next;
    }

    if (pieces.every((piece, position) => piece === position)) {
      const next = neighbors(blankPosition, previous)[0];
      [pieces[blankPosition], pieces[next]] = [pieces[next], pieces[blankPosition]];
    }

    moves = 0;
    render();
  }

  const tiles = Array.from({ length: count }, (_, piece) => {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "puzzle-tile";
    tile.draggable = false;
    tile.dataset.piece = String(piece);
    tile.style.setProperty("--piece-x", `${(piece % size) * 25}%`);
    tile.style.setProperty("--piece-y", `${Math.floor(piece / size) * 25}%`);
    const number = document.createElement("span");
    number.className = "puzzle-number";
    number.textContent = String(piece + 1);
    number.setAttribute("aria-hidden", "true");
    tile.append(number);
    tile.addEventListener("click", () => move(piece));
    return tile;
  });

  board.style.setProperty("--puzzle-size", String(size));
  board.replaceChildren(...tiles);
  shuffleButton.addEventListener("click", handleShuffle);
  shuffle();
  shuffleButton.disabled = false;
})();
