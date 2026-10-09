/** Constructed Android side-button contact fixture; captured facts remain in the separate ledger. */
export const ISSUE25_FIXTURE = {
  "status": "Android contact-intent fixture; runtime validation pending",
  "destination": "src/ink/Issue25HoldRelease.fixture.ts",
  "observedBase": "984a5a40484a504ea9163661f77120a34365bfab",
  "observedTree": "f6580aaa06641589b41afa1544c878531c6e62d8",
  "behaviorAuthority": {
    "path": "LANEP-SCOPE-BINDING-20261007.json",
    "sha256": "9261233a6b47956c34c6e9cd57a33bb1ac8945fb2bc74d550924940336561676"
  },
  "captureLedger": {
    "artifact": {
      "path": "ISSUE25-CAPTURE-LEDGER.json",
      "sha256": "39816bcd906228a3e8f3740f8c88c5af10964f58efc60619b6e180feb7a2c4df"
    },
    "destination": "src/ink/Issue25CaptureLedger.fixture.json",
    "traceEvents": 253,
    "rawRows": 1678,
    "rawPins": [
      {
        "path": "handwriting-diagnostics-20261006-011054.md",
        "sha256": "f9b99f6c0e4498234f39d4f380a95139a0c6944cf5385112cae8a295d6bc1204",
        "bytes": 27555
      },
      {
        "path": "spen-diagnostic-log.txt",
        "sha256": "dda7249fdc9dac7754b04a19bcc869577c3fc7b41760d1088393a7dd8d7ac64d",
        "bytes": 141764
      },
      {
        "path": "FETCH-RECEIPT.json",
        "sha256": "f63bdc6012c1bbc1e694bac1adc7638416f969dda30dc4d45181cef607285b8e",
        "bytes": 1221
      },
      {
        "path": "PARSED-ATTACHMENTS.json",
        "sha256": "39816bcd906228a3e8f3740f8c88c5af10964f58efc60619b6e180feb7a2c4df",
        "bytes": 745048
      }
    ],
    "limits": [
      "The files are reporter-provided captures; their recording completeness, device/build identity and diagnostic implementation are not verified.",
      "Missing events in a finite capture do not prove platform-wide unavailability.",
      "PRESSED BUT NO pointerdown is a diagnostic label; it does not itself prove physical contact or barrel-button identity.",
      "No product source, runtime, fixture, test, runner or implementation was executed."
    ]
  },
  "holdCases": [
    {
      "id": "held-pen-stroke-pointerrawupdate",
      "prior": {
        "inlineTool": "pen",
        "inkSizeMult": 1.5,
        "tipMode": "nib",
        "toolbarTool": "pen"
      },
      "eraser": {
        "chip": "Stroke",
        "wholeStrokes": true,
        "radiusPx": 11
      },
      "steps": [
        {
          "event": {
            "type": "pointermove",
            "timeStamp": 100,
            "advanceClockToMs": 100,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": 2,
            "buttons": 2,
            "pressure": 0,
            "clientX": 110.0,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "pen",
            "inkSizeMult": 1.5,
            "tipMode": "nib",
            "toolbarTool": "pen"
          },
          "contactDowns": 0,
          "focusCalls": 0
        },
        {
          "event": {
            "type": "pointerdown",
            "timeStamp": 112,
            "advanceClockToMs": 112,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": 0,
            "buttons": 3,
            "pressure": 0.5,
            "clientX": 111.2,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "pen",
            "inkSizeMult": 1.5,
            "tipMode": "nib",
            "toolbarTool": "pen",
            "contactIntent": "erase",
            "eraseWhole": true,
            "eraserRadiusPx": 11
          },
          "contactDowns": 1
        },
        {
          "event": {
            "type": "pointerrawupdate",
            "timeStamp": 128,
            "advanceClockToMs": 128,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": -1,
            "buttons": 3,
            "pressure": 0.55,
            "clientX": 112.8,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "pen",
            "inkSizeMult": 1.5,
            "tipMode": "nib",
            "toolbarTool": "pen",
            "contactIntent": "erase",
            "eraseWhole": true,
            "eraserRadiusPx": 11
          },
          "requireNonemptyAcceptedSamples": true
        },
        {
          "event": {
            "type": "pointermove",
            "timeStamp": 144,
            "advanceClockToMs": 144,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": 2,
            "buttons": 1,
            "pressure": 0.5,
            "clientX": 114.4,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "pen",
            "inkSizeMult": 1.5,
            "tipMode": "nib",
            "toolbarTool": "pen"
          },
          "releaseMeaning": "barrel released while tip remains in contact"
        },
        {
          "event": {
            "type": "pointerup",
            "timeStamp": 160,
            "advanceClockToMs": 160,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": 0,
            "buttons": 0,
            "pressure": 0,
            "clientX": 116.0,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "pen",
            "inkSizeMult": 1.5,
            "tipMode": "nib",
            "toolbarTool": "pen"
          }
        },
        {
          "event": {
            "type": "pointerdown",
            "timeStamp": 176,
            "advanceClockToMs": 176,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": 0,
            "buttons": 1,
            "pressure": 0.5,
            "clientX": 117.6,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "pen",
            "inkSizeMult": 1.5,
            "tipMode": "nib",
            "toolbarTool": "pen"
          },
          "contactIntent": "ink"
        },
        {
          "event": {
            "type": "pointerup",
            "timeStamp": 192,
            "advanceClockToMs": 192,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": 0,
            "buttons": 0,
            "pressure": 0,
            "clientX": 119.2,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "pen",
            "inkSizeMult": 1.5,
            "tipMode": "nib",
            "toolbarTool": "pen"
          }
        }
      ],
      "invariants": [
        "No toggle persists after release",
        "Original tool and its size never overwritten",
        "Selected eraser chip and radius retained",
        "Mounted strip retains the original tool throughout contact and release",
        "Preserve original terminal event identity; finalization once per ended gesture",
        "No empty callback trace accepted as a pass"
      ]
    },
    {
      "id": "held-pen-stroke-pointermove",
      "prior": {
        "inlineTool": "pen",
        "inkSizeMult": 1.5,
        "tipMode": "nib",
        "toolbarTool": "pen"
      },
      "eraser": {
        "chip": "Stroke",
        "wholeStrokes": true,
        "radiusPx": 11
      },
      "steps": [
        {
          "event": {
            "type": "pointermove",
            "timeStamp": 100,
            "advanceClockToMs": 100,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": 2,
            "buttons": 2,
            "pressure": 0,
            "clientX": 110.0,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "pen",
            "inkSizeMult": 1.5,
            "tipMode": "nib",
            "toolbarTool": "pen"
          },
          "contactDowns": 0,
          "focusCalls": 0
        },
        {
          "event": {
            "type": "pointerdown",
            "timeStamp": 112,
            "advanceClockToMs": 112,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": 0,
            "buttons": 3,
            "pressure": 0.5,
            "clientX": 111.2,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "pen",
            "inkSizeMult": 1.5,
            "tipMode": "nib",
            "toolbarTool": "pen",
            "contactIntent": "erase",
            "eraseWhole": true,
            "eraserRadiusPx": 11
          },
          "contactDowns": 1
        },
        {
          "event": {
            "type": "pointermove",
            "timeStamp": 128,
            "advanceClockToMs": 128,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": -1,
            "buttons": 3,
            "pressure": 0.55,
            "clientX": 112.8,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "pen",
            "inkSizeMult": 1.5,
            "tipMode": "nib",
            "toolbarTool": "pen",
            "contactIntent": "erase",
            "eraseWhole": true,
            "eraserRadiusPx": 11
          },
          "requireNonemptyAcceptedSamples": true
        },
        {
          "event": {
            "type": "pointermove",
            "timeStamp": 144,
            "advanceClockToMs": 144,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": 2,
            "buttons": 1,
            "pressure": 0.5,
            "clientX": 114.4,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "pen",
            "inkSizeMult": 1.5,
            "tipMode": "nib",
            "toolbarTool": "pen"
          },
          "releaseMeaning": "barrel released while tip remains in contact"
        },
        {
          "event": {
            "type": "pointerup",
            "timeStamp": 160,
            "advanceClockToMs": 160,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": 0,
            "buttons": 0,
            "pressure": 0,
            "clientX": 116.0,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "pen",
            "inkSizeMult": 1.5,
            "tipMode": "nib",
            "toolbarTool": "pen"
          }
        },
        {
          "event": {
            "type": "pointerdown",
            "timeStamp": 176,
            "advanceClockToMs": 176,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": 0,
            "buttons": 1,
            "pressure": 0.5,
            "clientX": 117.6,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "pen",
            "inkSizeMult": 1.5,
            "tipMode": "nib",
            "toolbarTool": "pen"
          },
          "contactIntent": "ink"
        },
        {
          "event": {
            "type": "pointerup",
            "timeStamp": 192,
            "advanceClockToMs": 192,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": 0,
            "buttons": 0,
            "pressure": 0,
            "clientX": 119.2,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "pen",
            "inkSizeMult": 1.5,
            "tipMode": "nib",
            "toolbarTool": "pen"
          }
        }
      ],
      "invariants": [
        "No toggle persists after release",
        "Original tool and its size never overwritten",
        "Selected eraser chip and radius retained",
        "Mounted strip retains the original tool throughout contact and release",
        "Preserve original terminal event identity; finalization once per ended gesture",
        "No empty callback trace accepted as a pass"
      ]
    },
    {
      "id": "held-pen-reticle-pointerrawupdate",
      "prior": {
        "inlineTool": "pen",
        "inkSizeMult": 1.5,
        "tipMode": "nib",
        "toolbarTool": "pen"
      },
      "eraser": {
        "chip": "Reticle",
        "wholeStrokes": false,
        "radiusPx": 23
      },
      "steps": [
        {
          "event": {
            "type": "pointermove",
            "timeStamp": 100,
            "advanceClockToMs": 100,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": 2,
            "buttons": 2,
            "pressure": 0,
            "clientX": 110.0,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "pen",
            "inkSizeMult": 1.5,
            "tipMode": "nib",
            "toolbarTool": "pen"
          },
          "contactDowns": 0,
          "focusCalls": 0
        },
        {
          "event": {
            "type": "pointerdown",
            "timeStamp": 112,
            "advanceClockToMs": 112,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": 0,
            "buttons": 3,
            "pressure": 0.5,
            "clientX": 111.2,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "pen",
            "inkSizeMult": 1.5,
            "tipMode": "nib",
            "toolbarTool": "pen",
            "contactIntent": "erase",
            "eraseWhole": false,
            "eraserRadiusPx": 23
          },
          "contactDowns": 1
        },
        {
          "event": {
            "type": "pointerrawupdate",
            "timeStamp": 128,
            "advanceClockToMs": 128,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": -1,
            "buttons": 3,
            "pressure": 0.55,
            "clientX": 112.8,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "pen",
            "inkSizeMult": 1.5,
            "tipMode": "nib",
            "toolbarTool": "pen",
            "contactIntent": "erase",
            "eraseWhole": false,
            "eraserRadiusPx": 23
          },
          "requireNonemptyAcceptedSamples": true
        },
        {
          "event": {
            "type": "pointermove",
            "timeStamp": 144,
            "advanceClockToMs": 144,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": 2,
            "buttons": 1,
            "pressure": 0.5,
            "clientX": 114.4,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "pen",
            "inkSizeMult": 1.5,
            "tipMode": "nib",
            "toolbarTool": "pen"
          },
          "releaseMeaning": "barrel released while tip remains in contact"
        },
        {
          "event": {
            "type": "pointerup",
            "timeStamp": 160,
            "advanceClockToMs": 160,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": 0,
            "buttons": 0,
            "pressure": 0,
            "clientX": 116.0,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "pen",
            "inkSizeMult": 1.5,
            "tipMode": "nib",
            "toolbarTool": "pen"
          }
        },
        {
          "event": {
            "type": "pointerdown",
            "timeStamp": 176,
            "advanceClockToMs": 176,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": 0,
            "buttons": 1,
            "pressure": 0.5,
            "clientX": 117.6,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "pen",
            "inkSizeMult": 1.5,
            "tipMode": "nib",
            "toolbarTool": "pen"
          },
          "contactIntent": "ink"
        },
        {
          "event": {
            "type": "pointerup",
            "timeStamp": 192,
            "advanceClockToMs": 192,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": 0,
            "buttons": 0,
            "pressure": 0,
            "clientX": 119.2,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "pen",
            "inkSizeMult": 1.5,
            "tipMode": "nib",
            "toolbarTool": "pen"
          }
        }
      ],
      "invariants": [
        "No toggle persists after release",
        "Original tool and its size never overwritten",
        "Selected eraser chip and radius retained",
        "Mounted strip retains the original tool throughout contact and release",
        "Preserve original terminal event identity; finalization once per ended gesture",
        "No empty callback trace accepted as a pass"
      ]
    },
    {
      "id": "held-pen-reticle-pointermove",
      "prior": {
        "inlineTool": "pen",
        "inkSizeMult": 1.5,
        "tipMode": "nib",
        "toolbarTool": "pen"
      },
      "eraser": {
        "chip": "Reticle",
        "wholeStrokes": false,
        "radiusPx": 23
      },
      "steps": [
        {
          "event": {
            "type": "pointermove",
            "timeStamp": 100,
            "advanceClockToMs": 100,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": 2,
            "buttons": 2,
            "pressure": 0,
            "clientX": 110.0,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "pen",
            "inkSizeMult": 1.5,
            "tipMode": "nib",
            "toolbarTool": "pen"
          },
          "contactDowns": 0,
          "focusCalls": 0
        },
        {
          "event": {
            "type": "pointerdown",
            "timeStamp": 112,
            "advanceClockToMs": 112,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": 0,
            "buttons": 3,
            "pressure": 0.5,
            "clientX": 111.2,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "pen",
            "inkSizeMult": 1.5,
            "tipMode": "nib",
            "toolbarTool": "pen",
            "contactIntent": "erase",
            "eraseWhole": false,
            "eraserRadiusPx": 23
          },
          "contactDowns": 1
        },
        {
          "event": {
            "type": "pointermove",
            "timeStamp": 128,
            "advanceClockToMs": 128,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": -1,
            "buttons": 3,
            "pressure": 0.55,
            "clientX": 112.8,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "pen",
            "inkSizeMult": 1.5,
            "tipMode": "nib",
            "toolbarTool": "pen",
            "contactIntent": "erase",
            "eraseWhole": false,
            "eraserRadiusPx": 23
          },
          "requireNonemptyAcceptedSamples": true
        },
        {
          "event": {
            "type": "pointermove",
            "timeStamp": 144,
            "advanceClockToMs": 144,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": 2,
            "buttons": 1,
            "pressure": 0.5,
            "clientX": 114.4,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "pen",
            "inkSizeMult": 1.5,
            "tipMode": "nib",
            "toolbarTool": "pen"
          },
          "releaseMeaning": "barrel released while tip remains in contact"
        },
        {
          "event": {
            "type": "pointerup",
            "timeStamp": 160,
            "advanceClockToMs": 160,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": 0,
            "buttons": 0,
            "pressure": 0,
            "clientX": 116.0,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "pen",
            "inkSizeMult": 1.5,
            "tipMode": "nib",
            "toolbarTool": "pen"
          }
        },
        {
          "event": {
            "type": "pointerdown",
            "timeStamp": 176,
            "advanceClockToMs": 176,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": 0,
            "buttons": 1,
            "pressure": 0.5,
            "clientX": 117.6,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "pen",
            "inkSizeMult": 1.5,
            "tipMode": "nib",
            "toolbarTool": "pen"
          },
          "contactIntent": "ink"
        },
        {
          "event": {
            "type": "pointerup",
            "timeStamp": 192,
            "advanceClockToMs": 192,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": 0,
            "buttons": 0,
            "pressure": 0,
            "clientX": 119.2,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "pen",
            "inkSizeMult": 1.5,
            "tipMode": "nib",
            "toolbarTool": "pen"
          }
        }
      ],
      "invariants": [
        "No toggle persists after release",
        "Original tool and its size never overwritten",
        "Selected eraser chip and radius retained",
        "Mounted strip retains the original tool throughout contact and release",
        "Preserve original terminal event identity; finalization once per ended gesture",
        "No empty callback trace accepted as a pass"
      ]
    },
    {
      "id": "held-highlighter-stroke-pointerrawupdate",
      "prior": {
        "inlineTool": "highlighter",
        "inkSizeMult": 3.25,
        "tipMode": "nib",
        "toolbarTool": "highlighter"
      },
      "eraser": {
        "chip": "Stroke",
        "wholeStrokes": true,
        "radiusPx": 11
      },
      "steps": [
        {
          "event": {
            "type": "pointermove",
            "timeStamp": 100,
            "advanceClockToMs": 100,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": 2,
            "buttons": 2,
            "pressure": 0,
            "clientX": 110.0,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "highlighter",
            "inkSizeMult": 3.25,
            "tipMode": "nib",
            "toolbarTool": "highlighter"
          },
          "contactDowns": 0,
          "focusCalls": 0
        },
        {
          "event": {
            "type": "pointerdown",
            "timeStamp": 112,
            "advanceClockToMs": 112,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": 0,
            "buttons": 3,
            "pressure": 0.5,
            "clientX": 111.2,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "highlighter",
            "inkSizeMult": 3.25,
            "tipMode": "nib",
            "toolbarTool": "highlighter",
            "contactIntent": "erase",
            "eraseWhole": true,
            "eraserRadiusPx": 11
          },
          "contactDowns": 1
        },
        {
          "event": {
            "type": "pointerrawupdate",
            "timeStamp": 128,
            "advanceClockToMs": 128,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": -1,
            "buttons": 3,
            "pressure": 0.55,
            "clientX": 112.8,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "highlighter",
            "inkSizeMult": 3.25,
            "tipMode": "nib",
            "toolbarTool": "highlighter",
            "contactIntent": "erase",
            "eraseWhole": true,
            "eraserRadiusPx": 11
          },
          "requireNonemptyAcceptedSamples": true
        },
        {
          "event": {
            "type": "pointermove",
            "timeStamp": 144,
            "advanceClockToMs": 144,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": 2,
            "buttons": 1,
            "pressure": 0.5,
            "clientX": 114.4,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "highlighter",
            "inkSizeMult": 3.25,
            "tipMode": "nib",
            "toolbarTool": "highlighter"
          },
          "releaseMeaning": "barrel released while tip remains in contact"
        },
        {
          "event": {
            "type": "pointerup",
            "timeStamp": 160,
            "advanceClockToMs": 160,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": 0,
            "buttons": 0,
            "pressure": 0,
            "clientX": 116.0,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "highlighter",
            "inkSizeMult": 3.25,
            "tipMode": "nib",
            "toolbarTool": "highlighter"
          }
        },
        {
          "event": {
            "type": "pointerdown",
            "timeStamp": 176,
            "advanceClockToMs": 176,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": 0,
            "buttons": 1,
            "pressure": 0.5,
            "clientX": 117.6,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "highlighter",
            "inkSizeMult": 3.25,
            "tipMode": "nib",
            "toolbarTool": "highlighter"
          },
          "contactIntent": "ink"
        },
        {
          "event": {
            "type": "pointerup",
            "timeStamp": 192,
            "advanceClockToMs": 192,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": 0,
            "buttons": 0,
            "pressure": 0,
            "clientX": 119.2,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "highlighter",
            "inkSizeMult": 3.25,
            "tipMode": "nib",
            "toolbarTool": "highlighter"
          }
        }
      ],
      "invariants": [
        "No toggle persists after release",
        "Original tool and its size never overwritten",
        "Selected eraser chip and radius retained",
        "Mounted strip retains the original tool throughout contact and release",
        "Preserve original terminal event identity; finalization once per ended gesture",
        "No empty callback trace accepted as a pass"
      ]
    },
    {
      "id": "held-highlighter-stroke-pointermove",
      "prior": {
        "inlineTool": "highlighter",
        "inkSizeMult": 3.25,
        "tipMode": "nib",
        "toolbarTool": "highlighter"
      },
      "eraser": {
        "chip": "Stroke",
        "wholeStrokes": true,
        "radiusPx": 11
      },
      "steps": [
        {
          "event": {
            "type": "pointermove",
            "timeStamp": 100,
            "advanceClockToMs": 100,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": 2,
            "buttons": 2,
            "pressure": 0,
            "clientX": 110.0,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "highlighter",
            "inkSizeMult": 3.25,
            "tipMode": "nib",
            "toolbarTool": "highlighter"
          },
          "contactDowns": 0,
          "focusCalls": 0
        },
        {
          "event": {
            "type": "pointerdown",
            "timeStamp": 112,
            "advanceClockToMs": 112,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": 0,
            "buttons": 3,
            "pressure": 0.5,
            "clientX": 111.2,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "highlighter",
            "inkSizeMult": 3.25,
            "tipMode": "nib",
            "toolbarTool": "highlighter",
            "contactIntent": "erase",
            "eraseWhole": true,
            "eraserRadiusPx": 11
          },
          "contactDowns": 1
        },
        {
          "event": {
            "type": "pointermove",
            "timeStamp": 128,
            "advanceClockToMs": 128,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": -1,
            "buttons": 3,
            "pressure": 0.55,
            "clientX": 112.8,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "highlighter",
            "inkSizeMult": 3.25,
            "tipMode": "nib",
            "toolbarTool": "highlighter",
            "contactIntent": "erase",
            "eraseWhole": true,
            "eraserRadiusPx": 11
          },
          "requireNonemptyAcceptedSamples": true
        },
        {
          "event": {
            "type": "pointermove",
            "timeStamp": 144,
            "advanceClockToMs": 144,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": 2,
            "buttons": 1,
            "pressure": 0.5,
            "clientX": 114.4,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "highlighter",
            "inkSizeMult": 3.25,
            "tipMode": "nib",
            "toolbarTool": "highlighter"
          },
          "releaseMeaning": "barrel released while tip remains in contact"
        },
        {
          "event": {
            "type": "pointerup",
            "timeStamp": 160,
            "advanceClockToMs": 160,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": 0,
            "buttons": 0,
            "pressure": 0,
            "clientX": 116.0,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "highlighter",
            "inkSizeMult": 3.25,
            "tipMode": "nib",
            "toolbarTool": "highlighter"
          }
        },
        {
          "event": {
            "type": "pointerdown",
            "timeStamp": 176,
            "advanceClockToMs": 176,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": 0,
            "buttons": 1,
            "pressure": 0.5,
            "clientX": 117.6,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "highlighter",
            "inkSizeMult": 3.25,
            "tipMode": "nib",
            "toolbarTool": "highlighter"
          },
          "contactIntent": "ink"
        },
        {
          "event": {
            "type": "pointerup",
            "timeStamp": 192,
            "advanceClockToMs": 192,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": 0,
            "buttons": 0,
            "pressure": 0,
            "clientX": 119.2,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "highlighter",
            "inkSizeMult": 3.25,
            "tipMode": "nib",
            "toolbarTool": "highlighter"
          }
        }
      ],
      "invariants": [
        "No toggle persists after release",
        "Original tool and its size never overwritten",
        "Selected eraser chip and radius retained",
        "Mounted strip retains the original tool throughout contact and release",
        "Preserve original terminal event identity; finalization once per ended gesture",
        "No empty callback trace accepted as a pass"
      ]
    },
    {
      "id": "held-highlighter-reticle-pointerrawupdate",
      "prior": {
        "inlineTool": "highlighter",
        "inkSizeMult": 3.25,
        "tipMode": "nib",
        "toolbarTool": "highlighter"
      },
      "eraser": {
        "chip": "Reticle",
        "wholeStrokes": false,
        "radiusPx": 23
      },
      "steps": [
        {
          "event": {
            "type": "pointermove",
            "timeStamp": 100,
            "advanceClockToMs": 100,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": 2,
            "buttons": 2,
            "pressure": 0,
            "clientX": 110.0,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "highlighter",
            "inkSizeMult": 3.25,
            "tipMode": "nib",
            "toolbarTool": "highlighter"
          },
          "contactDowns": 0,
          "focusCalls": 0
        },
        {
          "event": {
            "type": "pointerdown",
            "timeStamp": 112,
            "advanceClockToMs": 112,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": 0,
            "buttons": 3,
            "pressure": 0.5,
            "clientX": 111.2,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "highlighter",
            "inkSizeMult": 3.25,
            "tipMode": "nib",
            "toolbarTool": "highlighter",
            "contactIntent": "erase",
            "eraseWhole": false,
            "eraserRadiusPx": 23
          },
          "contactDowns": 1
        },
        {
          "event": {
            "type": "pointerrawupdate",
            "timeStamp": 128,
            "advanceClockToMs": 128,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": -1,
            "buttons": 3,
            "pressure": 0.55,
            "clientX": 112.8,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "highlighter",
            "inkSizeMult": 3.25,
            "tipMode": "nib",
            "toolbarTool": "highlighter",
            "contactIntent": "erase",
            "eraseWhole": false,
            "eraserRadiusPx": 23
          },
          "requireNonemptyAcceptedSamples": true
        },
        {
          "event": {
            "type": "pointermove",
            "timeStamp": 144,
            "advanceClockToMs": 144,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": 2,
            "buttons": 1,
            "pressure": 0.5,
            "clientX": 114.4,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "highlighter",
            "inkSizeMult": 3.25,
            "tipMode": "nib",
            "toolbarTool": "highlighter"
          },
          "releaseMeaning": "barrel released while tip remains in contact"
        },
        {
          "event": {
            "type": "pointerup",
            "timeStamp": 160,
            "advanceClockToMs": 160,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": 0,
            "buttons": 0,
            "pressure": 0,
            "clientX": 116.0,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "highlighter",
            "inkSizeMult": 3.25,
            "tipMode": "nib",
            "toolbarTool": "highlighter"
          }
        },
        {
          "event": {
            "type": "pointerdown",
            "timeStamp": 176,
            "advanceClockToMs": 176,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": 0,
            "buttons": 1,
            "pressure": 0.5,
            "clientX": 117.6,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "highlighter",
            "inkSizeMult": 3.25,
            "tipMode": "nib",
            "toolbarTool": "highlighter"
          },
          "contactIntent": "ink"
        },
        {
          "event": {
            "type": "pointerup",
            "timeStamp": 192,
            "advanceClockToMs": 192,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": 0,
            "buttons": 0,
            "pressure": 0,
            "clientX": 119.2,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "highlighter",
            "inkSizeMult": 3.25,
            "tipMode": "nib",
            "toolbarTool": "highlighter"
          }
        }
      ],
      "invariants": [
        "No toggle persists after release",
        "Original tool and its size never overwritten",
        "Selected eraser chip and radius retained",
        "Mounted strip retains the original tool throughout contact and release",
        "Preserve original terminal event identity; finalization once per ended gesture",
        "No empty callback trace accepted as a pass"
      ]
    },
    {
      "id": "held-highlighter-reticle-pointermove",
      "prior": {
        "inlineTool": "highlighter",
        "inkSizeMult": 3.25,
        "tipMode": "nib",
        "toolbarTool": "highlighter"
      },
      "eraser": {
        "chip": "Reticle",
        "wholeStrokes": false,
        "radiusPx": 23
      },
      "steps": [
        {
          "event": {
            "type": "pointermove",
            "timeStamp": 100,
            "advanceClockToMs": 100,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": 2,
            "buttons": 2,
            "pressure": 0,
            "clientX": 110.0,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "highlighter",
            "inkSizeMult": 3.25,
            "tipMode": "nib",
            "toolbarTool": "highlighter"
          },
          "contactDowns": 0,
          "focusCalls": 0
        },
        {
          "event": {
            "type": "pointerdown",
            "timeStamp": 112,
            "advanceClockToMs": 112,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": 0,
            "buttons": 3,
            "pressure": 0.5,
            "clientX": 111.2,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "highlighter",
            "inkSizeMult": 3.25,
            "tipMode": "nib",
            "toolbarTool": "highlighter",
            "contactIntent": "erase",
            "eraseWhole": false,
            "eraserRadiusPx": 23
          },
          "contactDowns": 1
        },
        {
          "event": {
            "type": "pointermove",
            "timeStamp": 128,
            "advanceClockToMs": 128,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": -1,
            "buttons": 3,
            "pressure": 0.55,
            "clientX": 112.8,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "highlighter",
            "inkSizeMult": 3.25,
            "tipMode": "nib",
            "toolbarTool": "highlighter",
            "contactIntent": "erase",
            "eraseWhole": false,
            "eraserRadiusPx": 23
          },
          "requireNonemptyAcceptedSamples": true
        },
        {
          "event": {
            "type": "pointermove",
            "timeStamp": 144,
            "advanceClockToMs": 144,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": 2,
            "buttons": 1,
            "pressure": 0.5,
            "clientX": 114.4,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "highlighter",
            "inkSizeMult": 3.25,
            "tipMode": "nib",
            "toolbarTool": "highlighter"
          },
          "releaseMeaning": "barrel released while tip remains in contact"
        },
        {
          "event": {
            "type": "pointerup",
            "timeStamp": 160,
            "advanceClockToMs": 160,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": 0,
            "buttons": 0,
            "pressure": 0,
            "clientX": 116.0,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "highlighter",
            "inkSizeMult": 3.25,
            "tipMode": "nib",
            "toolbarTool": "highlighter"
          }
        },
        {
          "event": {
            "type": "pointerdown",
            "timeStamp": 176,
            "advanceClockToMs": 176,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": 0,
            "buttons": 1,
            "pressure": 0.5,
            "clientX": 117.6,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "highlighter",
            "inkSizeMult": 3.25,
            "tipMode": "nib",
            "toolbarTool": "highlighter"
          },
          "contactIntent": "ink"
        },
        {
          "event": {
            "type": "pointerup",
            "timeStamp": 192,
            "advanceClockToMs": 192,
            "pointerType": "pen",
            "pointerId": 31,
            "isPrimary": true,
            "button": 0,
            "buttons": 0,
            "pressure": 0,
            "clientX": 119.2,
            "clientY": 120,
            "deliverySite": "owned-element",
            "provenance": "constructed contract stimulus, not measured capture"
          },
          "expected": {
            "inlineTool": "highlighter",
            "inkSizeMult": 3.25,
            "tipMode": "nib",
            "toolbarTool": "highlighter"
          }
        }
      ],
      "invariants": [
        "No toggle persists after release",
        "Original tool and its size never overwritten",
        "Selected eraser chip and radius retained",
        "Mounted strip retains the original tool throughout contact and release",
        "Preserve original terminal event identity; finalization once per ended gesture",
        "No empty callback trace accepted as a pass"
      ]
    }
  ],
  "controls": [
    {
      "id": "barrel-hover-only",
      "events": [
        {
          "type": "pointermove",
          "timeStamp": 100,
          "advanceClockToMs": 100,
          "pointerType": "pen",
          "pointerId": 31,
          "isPrimary": true,
          "button": 2,
          "buttons": 2,
          "pressure": 0,
          "clientX": 110.0,
          "clientY": 120,
          "deliverySite": "owned-element",
          "provenance": "constructed contract stimulus, not measured capture"
        },
        {
          "type": "pointermove",
          "timeStamp": 116,
          "advanceClockToMs": 116,
          "pointerType": "pen",
          "pointerId": 31,
          "isPrimary": true,
          "button": -1,
          "buttons": 2,
          "pressure": 0,
          "clientX": 111.6,
          "clientY": 120,
          "deliverySite": "owned-element",
          "provenance": "constructed contract stimulus, not measured capture"
        },
        {
          "type": "pointermove",
          "timeStamp": 132,
          "advanceClockToMs": 132,
          "pointerType": "pen",
          "pointerId": 31,
          "isPrimary": true,
          "button": 2,
          "buttons": 0,
          "pressure": 0,
          "clientX": 113.2,
          "clientY": 120,
          "deliverySite": "owned-element",
          "provenance": "constructed contract stimulus, not measured capture"
        }
      ],
      "oracle": "No erase/ink contact, no tool or toolbar change, no editor focus or keyboard-opening call; nonempty hover delivery witness."
    },
    {
      "id": "ordinary-tip",
      "events": [
        {
          "type": "pointerdown",
          "timeStamp": 100,
          "advanceClockToMs": 100,
          "pointerType": "pen",
          "pointerId": 31,
          "isPrimary": true,
          "button": 0,
          "buttons": 1,
          "pressure": 0.5,
          "clientX": 110.0,
          "clientY": 120,
          "deliverySite": "owned-element",
          "provenance": "constructed contract stimulus, not measured capture"
        },
        {
          "type": "pointermove",
          "timeStamp": 116,
          "advanceClockToMs": 116,
          "pointerType": "pen",
          "pointerId": 31,
          "isPrimary": true,
          "button": -1,
          "buttons": 1,
          "pressure": 0.5,
          "clientX": 111.6,
          "clientY": 120,
          "deliverySite": "owned-element",
          "provenance": "constructed contract stimulus, not measured capture"
        },
        {
          "type": "pointerup",
          "timeStamp": 132,
          "advanceClockToMs": 132,
          "pointerType": "pen",
          "pointerId": 31,
          "isPrimary": true,
          "button": 0,
          "buttons": 0,
          "pressure": 0,
          "clientX": 113.2,
          "clientY": 120,
          "deliverySite": "owned-element",
          "provenance": "constructed contract stimulus, not measured capture"
        }
      ],
      "oracle": "One ink contact through the real route, nonempty samples, original tool/size preserved; buttons=1 is never barrel."
    },
    {
      "id": "pressed-hover-then-real-down",
      "events": [
        {
          "type": "pointermove",
          "timeStamp": 6204.8,
          "advanceClockToMs": 6204.8,
          "pointerType": "pen",
          "pointerId": 3,
          "isPrimary": true,
          "button": -1,
          "buttons": 1,
          "pressure": 0.087,
          "clientX": 720.48,
          "clientY": 120,
          "deliverySite": "owned-element",
          "provenance": "constructed contract stimulus, not measured capture"
        },
        {
          "type": "pointerdown",
          "timeStamp": 6210.3,
          "advanceClockToMs": 6210.3,
          "pointerType": "pen",
          "pointerId": 3,
          "isPrimary": true,
          "button": 0,
          "buttons": 1,
          "pressure": 0.5,
          "clientX": 721.03,
          "clientY": 120,
          "deliverySite": "owned-element",
          "provenance": "constructed contract stimulus, not measured capture"
        },
        {
          "type": "pointerup",
          "timeStamp": 7280.1,
          "advanceClockToMs": 7280.1,
          "pointerType": "pen",
          "pointerId": 3,
          "isPrimary": true,
          "button": 0,
          "buttons": 0,
          "pressure": 0,
          "clientX": 828.01,
          "clientY": 120,
          "deliverySite": "owned-element",
          "provenance": "constructed contract stimulus, not measured capture"
        }
      ],
      "oracle": "Constructed routing control using named recorded times and hover fields; invented down/up pressure is explicit. No barrel inference or second contact. Full captured facts remain in separate ledger."
    },
    {
      "id": "native-eraser",
      "events": [
        {
          "type": "pointerdown",
          "timeStamp": 100,
          "advanceClockToMs": 100,
          "pointerType": "pen",
          "pointerId": 31,
          "isPrimary": true,
          "button": 5,
          "buttons": 32,
          "pressure": 0.5,
          "clientX": 110.0,
          "clientY": 120,
          "deliverySite": "owned-element",
          "provenance": "constructed contract stimulus, not measured capture"
        },
        {
          "type": "pointermove",
          "timeStamp": 116,
          "advanceClockToMs": 116,
          "pointerType": "pen",
          "pointerId": 31,
          "isPrimary": true,
          "button": -1,
          "buttons": 32,
          "pressure": 0.5,
          "clientX": 111.6,
          "clientY": 120,
          "deliverySite": "owned-element",
          "provenance": "constructed contract stimulus, not measured capture"
        },
        {
          "type": "pointerup",
          "timeStamp": 132,
          "advanceClockToMs": 132,
          "pointerType": "pen",
          "pointerId": 31,
          "isPrimary": true,
          "button": 5,
          "buttons": 0,
          "pressure": 0,
          "clientX": 113.2,
          "clientY": 120,
          "deliverySite": "owned-element",
          "provenance": "constructed contract stimulus, not measured capture"
        }
      ],
      "oracle": "Existing real native-eraser behavior remains: selected Stroke/Reticle semantics and radius. Do not reinterpret eraser end as barrel or impose new toolbar behavior."
    },
    {
      "id": "touch-not-barrel",
      "events": [
        {
          "type": "pointerdown",
          "timeStamp": 100,
          "advanceClockToMs": 100,
          "pointerType": "touch",
          "pointerId": 41,
          "isPrimary": true,
          "button": 0,
          "buttons": 1,
          "pressure": 0.5,
          "clientX": 110.0,
          "clientY": 120,
          "deliverySite": "owned-element",
          "provenance": "constructed contract stimulus, not measured capture"
        },
        {
          "type": "pointerup",
          "timeStamp": 132,
          "advanceClockToMs": 132,
          "pointerType": "touch",
          "pointerId": 41,
          "isPrimary": true,
          "button": 0,
          "buttons": 0,
          "pressure": 0,
          "clientX": 113.2,
          "clientY": 120,
          "deliverySite": "owned-element",
          "provenance": "constructed contract stimulus, not measured capture"
        }
      ],
      "oracle": "Existing touch/pinch policy preserved; no temporary barrel eraser state. Positive delivery witness required."
    },
    {
      "id": "cancel-releases-hold",
      "events": [
        {
          "type": "pointerdown",
          "timeStamp": 100,
          "advanceClockToMs": 100,
          "pointerType": "pen",
          "pointerId": 31,
          "isPrimary": true,
          "button": 0,
          "buttons": 3,
          "pressure": 0.5,
          "clientX": 110.0,
          "clientY": 120,
          "deliverySite": "owned-element",
          "provenance": "constructed contract stimulus, not measured capture"
        },
        {
          "type": "pointercancel",
          "timeStamp": 132,
          "advanceClockToMs": 132,
          "pointerType": "pen",
          "pointerId": 31,
          "isPrimary": true,
          "button": -1,
          "buttons": 0,
          "pressure": 0,
          "clientX": 113.2,
          "clientY": 120,
          "deliverySite": "owned-element",
          "provenance": "constructed contract stimulus, not measured capture"
        }
      ],
      "oracle": "Temporary state ends; original tool/size restored once; no persisted toggle or duplicate finalization."
    },
    {
      "id": "lost-capture-releases-hold",
      "events": [
        {
          "type": "pointerdown",
          "timeStamp": 100,
          "advanceClockToMs": 100,
          "pointerType": "pen",
          "pointerId": 31,
          "isPrimary": true,
          "button": 0,
          "buttons": 3,
          "pressure": 0.5,
          "clientX": 110.0,
          "clientY": 120,
          "deliverySite": "owned-element",
          "provenance": "constructed contract stimulus, not measured capture"
        },
        {
          "type": "lostpointercapture",
          "timeStamp": 132,
          "advanceClockToMs": 132,
          "pointerType": "pen",
          "pointerId": 31,
          "isPrimary": true,
          "button": -1,
          "buttons": 0,
          "pressure": 0,
          "clientX": 113.2,
          "clientY": 120,
          "deliverySite": "owned-element",
          "provenance": "constructed contract stimulus, not measured capture"
        }
      ],
      "oracle": "Drive the registered window/element capture route as actually wired; original tool/size restored once. Do not invent a routed captured record with unknown target."
    }
  ],
  "harnessContract": [
    "Use existing test/routerHarness fakeEl/installFakeWindow and actual InlinePenRouter registered handlers; never call its private handlers directly.",
    "penEvent has no button option and defaults pointerId=7/button=0. Explicitly pass pointerId and then set the recorded/constructed button on every event. Assert field equality before routing.",
    "Drive actual InkOverlayPlugin.penDown for contact intent, eraseWhole and radius. Reuse existing EraserModeSticks/InlineEraserSelection rigs; stub unrelated rendering only, never tool state, eraser choice or restoration.",
    "Mount actual MobileTools using its existing test fake DOM/host and real state getters. Assert visible selected tool while held and after release; a tipMode getter alone does not prove toolbar rendering.",
    "Spy on editor focus and keyboard-opening paths for hover-only barrel press. DOM focus/keyboard effects are a future unit boundary; actual device keyboard behavior remains a device check.",
    "Advance fake performance/wall timer clock explicitly per advanceClockToMs, separately from event.timeStamp; install/restore existing fake timers/window/diagnostic switches per arm.",
    "Assert nonempty positive delivery and expected down/up/capture identity counts. Dispose router and mounted tools, drain/cancel registered timers and restore global tool/size state in finally.",
    "Keep entire capture ledger including diagnostic annotations, unknown targets, contextmenu and capture changes. Only route records with established delivery sites; do not deduplicate by time/type.",
    "Fidelity assertions compare every retained record including null/unknown fields and line provenance to the pinned ledger. Header suppressed6 and timeline suppressed2 are separate; no complete-native-ledger claim."
  ],
  "qualification": "8 constructed Android hold arms plus 7 controls. Side-button contact does not change tip mode or toolbar selection. Captured ledger remains unchanged."
} as const;
