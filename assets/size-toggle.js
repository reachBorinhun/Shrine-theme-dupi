document.addEventListener("DOMContentLoaded", function () {
  // Helper to open/close a container and manage ARIA
  function openSizeContainer(sizeContainer, btn) {
    if (!sizeContainer || !btn) return;
    // Set ARIA on the toggle immediately
    btn.setAttribute("aria-expanded", "true");
    btn.setAttribute("aria-label", "Hide size options");

    // Try to display the swatches inside the card content (full-width).
    try {
      var movedToCard = moveSizeContainerToCardContent(sizeContainer);
      if (!movedToCard) {
        // If not moved into card content, decide whether to reparent to body
        // for pointer-events reasons or align to the toggle in-place.
        if (needsReparent(sizeContainer, btn)) {
          moveSizeContainerToBody(sizeContainer, btn);
        } else {
          alignSwatchesToToggle(sizeContainer, btn);
        }
      }
    } catch (e) {}

    // Now trigger the enter animation by adding .is-visible on the next frame
    // allow CSS transitions to run. Set aria-hidden and focus after animation starts.
    requestAnimationFrame(function () {
      // Force layout so transition starts reliably
      void sizeContainer.offsetHeight;
      sizeContainer.classList.add("is-visible");
      sizeContainer.setAttribute("aria-hidden", "false");
      const firstSwatch = sizeContainer.querySelector(
        ".variant-swatch:not([disabled])"
      );
      if (firstSwatch) firstSwatch.focus({ preventScroll: true });
    });
  }

  function closeSizeContainer(sizeContainer) {
    if (!sizeContainer) return;
    // Trigger hide animation by removing the visible class; restore DOM after
    // transition completes so the exit animation can play.
    sizeContainer.classList.remove("is-visible");
    sizeContainer.classList.add("closing");
    sizeContainer.setAttribute("aria-hidden", "true");
    const productId = sizeContainer.getAttribute("data-product-id");
    const toggleBtn = document.querySelector(
      `.size-toggle-btn[data-product-id="${productId}"]`
    );
    if (toggleBtn) {
      toggleBtn.setAttribute("aria-expanded", "false");
      toggleBtn.setAttribute("aria-label", "Show size options");
    }
    // clear any transient pointerdown flag
    if (sizeContainer.dataset.openedByPointerDown) {
      delete sizeContainer.dataset.openedByPointerDown;
    }

    var cleaned = false;
    function finishClose() {
      if (cleaned) return;
      cleaned = true;
      // Remove class used to speed up hide
      sizeContainer.classList.remove("closing");

      // If we moved the container to body or card content, restore it back
      try {
        restoreMovedSizeContainer(sizeContainer);
      } catch (e) {}

      // If we didn't move it but aligned to the toggle, clear transient styles
      try {
        if (sizeContainer.dataset.__movedToBody !== "true") {
          sizeContainer.classList.remove("align-to-toggle");
          sizeContainer.style.left = "";
          sizeContainer.style.top = "";
          sizeContainer.style.width = "";
          sizeContainer.style.transform = "";
          sizeContainer.style.position = "";
          sizeContainer.style.zIndex = "";
          sizeContainer.style.pointerEvents = "";
        }
      } catch (e) {}
    }

    // Listen for transition end, but also use a timeout fallback
    var to = setTimeout(finishClose, 400);
    function onEnd(e) {
      if (e && e.target !== sizeContainer) return;
      clearTimeout(to);
      sizeContainer.removeEventListener("transitionend", onEnd);
      finishClose();
    }
    sizeContainer.addEventListener("transitionend", onEnd);
  }

  // Keep a map of moved containers to their original parent/nextSibling
  var _movedContainers = new WeakMap();

  function moveSizeContainerToBody(container) {
    // Optional second arg may be the toggle button used for anchor positioning
    var btn = arguments.length > 1 ? arguments[1] : null;
    if (!container || container.dataset.__movedToBody === "true") return;

    var origParent = container.parentNode;
    var origNext = container.nextSibling;
    if (!origParent) return;

    // Compute current onscreen position
    var rect = container.getBoundingClientRect();
    var top = rect.top + window.scrollY;
    var left = rect.left + window.scrollX;
    var width = rect.width;

    // Save original references and inline styles to the WeakMap
    _movedContainers.set(container, {
      parent: origParent,
      nextSibling: origNext,
      style: {
        position: container.style.position || "",
        top: container.style.top || "",
        left: container.style.left || "",
        width: container.style.width || "",
        zIndex: container.style.zIndex || "",
        pointerEvents: container.style.pointerEvents || "",
      },
      type: "body",
    });

    // Apply absolute positioning so it overlays exactly where it was.
    container.style.position = "absolute";
    container.style.width = Math.max(0, width) + "px";

    // If a toggle button was provided, prefer anchoring horizontally on its center
    // and vertically just above the button so the swatches appear to come from it.
    if (btn && btn.getBoundingClientRect) {
      var bRect = btn.getBoundingClientRect();
      var btnCenterX = bRect.left + bRect.width / 2 + window.scrollX;
      var btnCenterY = bRect.top + bRect.height / 2 + window.scrollY;
      // measure container height (may be zero until in DOM) - append first
      container.style.top = top + "px"; // temporary
      document.body.appendChild(container);
      var cRect = container.getBoundingClientRect();
      var cWidth = cRect.width;
      var cHeight = cRect.height;
      // Horizontal: center on button
      var desiredLeft = Math.round(btnCenterX - cWidth / 2);
      // Keep within viewport with some padding
      var pad = 8;
      desiredLeft = Math.max(
        pad + window.scrollX,
        Math.min(
          desiredLeft,
          Math.round(window.scrollX + window.innerWidth - cWidth - pad)
        )
      );
      // Vertical: center the panel on the button so it overlays the + button
      var desiredTop = Math.round(btnCenterY - cHeight / 2);
      container.style.left = desiredLeft + "px";
      container.style.top = desiredTop + "px";
      // store width to restore later
      container.style.width = Math.max(0, cWidth) + "px";
      // ensure pointer events and stacking
      // Ensure the panel sits above the toggle button (toggle uses 2147483647)
      container.style.zIndex = "2147483648";
      container.style.pointerEvents = "auto";
      container.dataset.__movedToBody = "true";
      return;
    }

    container.style.top = top + "px";
    container.style.left = left + "px";
    container.style.width = Math.max(0, width) + "px";
    // Force a very high stacking context and ensure pointer events are enabled
    container.style.zIndex = "2147483648";
    container.style.pointerEvents = "auto";

    // Mark moved and append to body
    container.dataset.__movedToBody = "true";
    document.body.appendChild(container);
  }

  // Move swatches into the card's .card__content element so they appear inside
  // the card area with full width. Returns true if moved.
  function moveSizeContainerToCardContent(container) {
    if (!container || container.dataset.__movedToCardContent === "true")
      return false;
    // Find nearest card container and its .card__content
    var card = container.closest(".card");
    if (!card) return false;
    var target = card.querySelector(".card__content");
    if (!target) return false;

    var origParent = container.parentNode;
    var origNext = container.nextSibling;
    if (!origParent) return false;

    // Save original references and inline styles to the WeakMap
    _movedContainers.set(container, {
      parent: origParent,
      nextSibling: origNext,
      style: {
        position: container.style.position || "",
        top: container.style.top || "",
        left: container.style.left || "",
        width: container.style.width || "",
        zIndex: container.style.zIndex || "",
        pointerEvents: container.style.pointerEvents || "",
      },
      type: "cardContent",
    });

    // Ensure the target is positioned so absolute children align to its bottom
    try {
      if (getComputedStyle(target).position === "static") {
        target.style.position = "relative";
        // mark that we changed it so we could optionally restore (skip for now)
        target.dataset.__madeRelativeForSwatches = "true";
      }
    } catch (e) {}

    // Append and position full-width across the card__content bottom
    container.style.position = "absolute";
    container.style.left = "0";
    container.style.right = "0";
    container.style.bottom = "0";
    container.style.width = "100%";
    container.style.zIndex = "2147483648";
    container.style.pointerEvents = "auto";
    container.dataset.__movedToCardContent = "true";
    target.appendChild(container);
    return true;
  }
  function needsReparent(container, btn) {
    if (!container || !document.elementFromPoint) return false;
    try {
      var rect = container.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) return false;

      var samplePoints = [];
      // center of the container
      samplePoints.push({
        x: (rect.left + rect.right) / 2,
        y: (rect.top + rect.bottom) / 2,
      });

      // also sample up to 3 swatches if present
      var swatches = container.querySelectorAll(".variant-swatch");
      for (var i = 0; i < Math.min(3, swatches.length); i++) {
        var s = swatches[i].getBoundingClientRect();
        samplePoints.push({
          x: (s.left + s.right) / 2,
          y: (s.top + s.bottom) / 2,
        });
      }

      for (var p = 0; p < samplePoints.length; p++) {
        var pt = samplePoints[p];
        // Round coordinates to avoid sub-pixel issues
        var cx = Math.round(pt.x);
        var cy = Math.round(pt.y);
        var top = document.elementFromPoint(cx, cy);
        if (!top) continue;
        if (container.contains(top) || top === container) {
          // at this point this sample is not blocked
          continue;
        }
        var toggleBtn =
          btn ||
          document.querySelector(
            '.size-toggle-btn[data-product-id="' +
              container.getAttribute("data-product-id") +
              '"]'
          );
        if (toggleBtn && (toggleBtn === top || toggleBtn.contains(top))) {
          continue;
        }

        // Otherwise the container is blocked at this sample point
        return true;
      }
    } catch (e) {
      return false;
    }
    return false;
  }

  function restoreMovedSizeContainer(container) {
    if (!container || container.dataset.__movedToBody !== "true") return;
    var saved = _movedContainers.get(container);
    if (!saved) return;

    // Restore inline styles
    try {
      container.style.position = saved.style.position;
      container.style.top = saved.style.top;
      container.style.left = saved.style.left;
      container.style.width = saved.style.width;
      container.style.zIndex = saved.style.zIndex;
      container.style.pointerEvents = saved.style.pointerEvents;
    } catch (e) {}

    // Put back into original place in the DOM
    try {
      if (saved.nextSibling && saved.nextSibling.parentNode === saved.parent) {
        saved.parent.insertBefore(container, saved.nextSibling);
      } else {
        saved.parent.appendChild(container);
      }
    } catch (e) {}

    delete container.dataset.__movedToBody;
    _movedContainers.delete(container);
  }

  function restoreMovedSizeContainer(container) {
    if (!container) return;
    var saved = _movedContainers.get(container);
    if (!saved) return;

    // Restore inline styles
    try {
      container.style.position = saved.style.position;
      container.style.top = saved.style.top;
      container.style.left = saved.style.left;
      container.style.width = saved.style.width;
      container.style.zIndex = saved.style.zIndex;
      container.style.pointerEvents = saved.style.pointerEvents;
    } catch (e) {}

    // Put back into original place in the DOM
    try {
      if (saved.nextSibling && saved.nextSibling.parentNode === saved.parent) {
        saved.parent.insertBefore(container, saved.nextSibling);
      } else {
        saved.parent.appendChild(container);
      }
    } catch (e) {}

    // Remove moved flags
    if (container.dataset.__movedToBody) delete container.dataset.__movedToBody;
    if (container.dataset.__movedToCardContent)
      delete container.dataset.__movedToCardContent;
    _movedContainers.delete(container);
  }

  function alignSwatchesToToggle(container, btn) {
    if (!container || !btn) return;
    // Ensure we have an offsetParent to compute coordinates against
    var offsetParent =
      container.offsetParent || container.parentNode || document.body;
    var parentRect = offsetParent.getBoundingClientRect();
    var bRect = btn.getBoundingClientRect();
    var btnCenterX = bRect.left + bRect.width / 2;
    var btnCenterY = bRect.top + bRect.height / 2;

    // Compute left/top relative to offsetParent and center the container on the button
    var cRect = container.getBoundingClientRect();
    var cWidth = cRect.width || Math.max(160, btn.offsetWidth * 3);
    var cHeight = cRect.height || 40;
    // desired left such that container center aligns with button center
    var desiredLeft = Math.round(btnCenterX - parentRect.left - cWidth / 2);
    // clamp within parent bounds
    var pad = 8;
    var minLeft = pad;
    var maxLeft = Math.round(parentRect.width - cWidth - pad);
    desiredLeft = Math.max(minLeft, Math.min(desiredLeft, maxLeft));

    container.classList.add("align-to-toggle");
    container.style.position = "absolute";
    // place the panel so its center aligns with the button center (overlap the +)
    var desiredTop = Math.round(btnCenterY - parentRect.top - cHeight / 2);
    // clamp within parent bounds
    desiredTop = Math.max(
      pad,
      Math.min(desiredTop, Math.round(parentRect.height - cHeight - pad))
    );
    container.style.left = desiredLeft + "px";
    container.style.top = desiredTop + "px";
    container.style.transform = "translateX(0)";
    container.style.width = Math.max(0, cWidth) + "px";
    // ensure the panel sits above the toggle so it visually hides it
    container.style.zIndex = "2147483648";
    container.style.pointerEvents = "auto";
  }

  // Delegate clicks to the document for dynamic product cards
  document.addEventListener("click", function (e) {
    const btn = e.target.closest(".size-toggle-btn");
    if (!btn) return;

    // prevent default to avoid accidental form submits if inside forms
    e.preventDefault();
    e.stopPropagation();

    const productId = btn.getAttribute("data-product-id");
    const sizeContainer = document.querySelector(
      `.card-size-swatches[data-product-id="${productId}"]`
    );
    if (!sizeContainer) return;

    const isVisible = sizeContainer.classList.contains("is-visible");
    if (isVisible) {
      closeSizeContainer(sizeContainer);
    } else {
      // Close any other open swatch containers so only one panel is visible
      try {
        document
          .querySelectorAll(".card-size-swatches.is-visible")
          .forEach(function (other) {
            if (other === sizeContainer) return;
            try {
              closeSizeContainer(other);
            } catch (e) {}
          });
      } catch (e) {}

      openSizeContainer(sizeContainer, btn);
    }
  });

  // Close size options when clicking outside a media card
  document.addEventListener("click", function (e) {
    if (
      e.target.closest(".card__media") ||
      e.target.closest(".card-size-swatches") ||
      e.target.closest(".variant-swatch") ||
      e.target.closest(".size-toggle-btn")
    ) {
      return; // click inside card media or swatches - ignore
    }

    document
      .querySelectorAll(".card-size-swatches.is-visible")
      .forEach((container) => {
        if (container.dataset.openedByPointerDown) {
          const openedAt = parseInt(container.dataset.openedByPointerDown, 10);
          if (Date.now() - openedAt < 400) {
            // remove the flag so subsequent clicks will close normally
            delete container.dataset.openedByPointerDown;
            return;
          }
        }

        closeSizeContainer(container);
      });
  });

  document.addEventListener(
    "pointerdown",
    function (e) {
      if (e.button !== 0) return; // left button only

      // Find any toggle whose visible rect contains the pointer
      const toggles = document.querySelectorAll(".size-toggle-btn");
      for (const btn of toggles) {
        const rect = btn.getBoundingClientRect();
        if (
          e.clientX >= rect.left &&
          e.clientX <= rect.right &&
          e.clientY >= rect.top &&
          e.clientY <= rect.bottom
        ) {
          const productId = btn.getAttribute("data-product-id");
          const sizeContainer = document.querySelector(
            `.card-size-swatches[data-product-id="${productId}"]`
          );
          if (!sizeContainer) return;

          if (!sizeContainer.classList.contains("is-visible")) {
            // Close any other open swatch containers first (capture path)
            try {
              document
                .querySelectorAll(".card-size-swatches.is-visible")
                .forEach(function (other) {
                  if (other === sizeContainer) return;
                  try {
                    closeSizeContainer(other);
                  } catch (e) {}
                });
            } catch (e) {}

            openSizeContainer(sizeContainer, btn);
            // mark timestamp so outside-click handler can ignore the immediate click
            sizeContainer.dataset.openedByPointerDown = String(Date.now());
            // expire flag after a short period
            setTimeout(() => {
              if (sizeContainer && sizeContainer.dataset.openedByPointerDown) {
                delete sizeContainer.dataset.openedByPointerDown;
              }
            }, 500);
          }
          return;
        }
      }
    },
    true
  );

  // Enforce transparent background on 'Adding...' labels even if other CSS/JS runs later.
  // This MutationObserver watches for class/aria changes on size buttons and variant swatches
  // and forces inline transparent background when they enter the loading/busy state.
  try {
    function enforceTransparentLoading(el) {
      if (!el) return;
      try {
        el.style.setProperty("background-color", "transparent", "important");
      } catch (e) {}
      try {
        el.style.setProperty("background", "transparent", "important");
      } catch (e) {}
      try {
        var label =
          el.querySelector &&
          (el.querySelector(".size-label-text") || el.querySelector("span"));
        if (label) {
          try {
            label.style.setProperty(
              "background-color",
              "transparent",
              "important"
            );
          } catch (e) {}
          try {
            label.style.setProperty("background", "transparent", "important");
          } catch (e) {}
        }
      } catch (e) {}
    }

    var mo = new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        var t = m.target;
        if (!t) return;
        try {
          if (
            t.classList &&
            (t.classList.contains("is-loading") ||
              t.getAttribute("aria-busy") === "true")
          ) {
            enforceTransparentLoading(t);
          }
        } catch (e) {}
      });
    });

    // Observe existing buttons
    document
      .querySelectorAll(".size-btn, .variant-swatch")
      .forEach(function (b) {
        try {
          mo.observe(b, {
            attributes: true,
            attributeFilter: ["class", "aria-busy"],
          });
        } catch (e) {}
      });

    // Observe the document for new buttons being added so we can attach observer
    try {
      var bodyMo = new MutationObserver(function (mutations) {
        mutations.forEach(function (m) {
          if (!m.addedNodes) return;
          m.addedNodes.forEach(function (n) {
            if (!n || !n.querySelector) return;
            var found =
              n.matches &&
              (n.matches(".size-btn") || n.matches(".variant-swatch"))
                ? [n]
                : Array.prototype.slice.call(
                    n.querySelectorAll(".size-btn, .variant-swatch")
                  );
            found.forEach(function (b) {
              try {
                mo.observe(b, {
                  attributes: true,
                  attributeFilter: ["class", "aria-busy"],
                });
              } catch (e) {}
            });
          });
        });
      });
      bodyMo.observe(document.body, { childList: true, subtree: true });
    } catch (e) {}
  } catch (e) {}
});
