
'use strict';
/* ============================================================================
   1. Effect registry — docs/effects-schema.json embedded VERBATIM.
      Keep byte-for-byte in sync with the firmware's EffectRegistry.cpp.
   ========================================================================== */
/* --- BEGIN effects-schema.json (verbatim) --- */
const EFFECTS_SCHEMA =
{
  "version": 1,
  "comment": "Single source of truth for the PatchScript effect registry. The firmware (EffectRegistry.cpp) and the Studio editor embed this table — keep all three in sync.",
  "constants": {
    "WAVEFORM_SINE": 0,
    "WAVEFORM_SAWTOOTH": 1,
    "WAVEFORM_SQUARE": 2,
    "WAVEFORM_TRIANGLE": 3,
    "WAVEFORM_ARBITRARY": 4,
    "WAVEFORM_PULSE": 5,
    "WAVEFORM_SAWTOOTH_REVERSE": 6,
    "WAVEFORM_SAMPLE_HOLD": 7,
    "WAVEFORM_TRIANGLE_VARIABLE": 8
  },
  "effects": [
    {
      "type": "AudioAmplifier",
      "label": "Gain / Boost",
      "category": "dynamics",
      "inputs": 1,
      "outputs": 1,
      "chain": true,
      "params": [
        {
          "method": "gain",
          "label": "Gain",
          "args": [
            {
              "name": "gain",
              "type": "float",
              "min": 0,
              "max": 4,
              "step": 0.01,
              "default": 1.0,
              "scale": "lin",
              "unit": "x"
            }
          ]
        }
      ]
    },
    {
      "type": "AudioMixer4",
      "label": "Mixer (4ch)",
      "category": "utility",
      "inputs": 4,
      "outputs": 1,
      "chain": false,
      "params": [
        {
          "method": "gain",
          "label": "Channel gain",
          "args": [
            {
              "name": "channel",
              "type": "int",
              "min": 0,
              "max": 3,
              "step": 1,
              "default": 0
            },
            {
              "name": "gain",
              "type": "float",
              "min": 0,
              "max": 4,
              "step": 0.01,
              "default": 1.0
            }
          ]
        }
      ]
    },
    {
      "type": "AudioEffectFreeverb",
      "label": "Reverb (Freeverb)",
      "category": "ambience",
      "inputs": 1,
      "outputs": 1,
      "chain": true,
      "wet": true,
      "params": [
        {
          "method": "roomsize",
          "label": "Room size",
          "args": [
            {
              "name": "size",
              "type": "float",
              "min": 0,
              "max": 1,
              "step": 0.01,
              "default": 0.7
            }
          ]
        },
        {
          "method": "damping",
          "label": "Damping",
          "args": [
            {
              "name": "damping",
              "type": "float",
              "min": 0,
              "max": 1,
              "step": 0.01,
              "default": 0.4
            }
          ]
        }
      ]
    },
    {
      "type": "AudioEffectFreeverbStereo",
      "label": "Reverb (Freeverb, stereo out)",
      "category": "ambience",
      "inputs": 1,
      "outputs": 2,
      "chain": false,
      "wet": true,
      "params": [
        {
          "method": "roomsize",
          "label": "Room size",
          "args": [
            {
              "name": "size",
              "type": "float",
              "min": 0,
              "max": 1,
              "step": 0.01,
              "default": 0.7
            }
          ]
        },
        {
          "method": "damping",
          "label": "Damping",
          "args": [
            {
              "name": "damping",
              "type": "float",
              "min": 0,
              "max": 1,
              "step": 0.01,
              "default": 0.4
            }
          ]
        }
      ]
    },
    {
      "type": "AudioEffectChorus",
      "label": "Chorus",
      "category": "modulation",
      "inputs": 1,
      "outputs": 1,
      "chain": true,
      "params": [
        {
          "method": "begin",
          "label": "Voices",
          "once": true,
          "args": [
            {
              "name": "voices",
              "type": "int",
              "min": 1,
              "max": 8,
              "step": 1,
              "default": 3
            }
          ],
          "note": "Firmware allocates the delay line; call once."
        },
        {
          "method": "voices",
          "label": "Voices (live)",
          "args": [
            {
              "name": "voices",
              "type": "int",
              "min": 1,
              "max": 8,
              "step": 1,
              "default": 3
            }
          ]
        }
      ]
    },
    {
      "type": "AudioEffectFlange",
      "label": "Flanger",
      "category": "modulation",
      "inputs": 1,
      "outputs": 1,
      "chain": true,
      "params": [
        {
          "method": "begin",
          "label": "Flange",
          "once": true,
          "args": [
            {
              "name": "offset",
              "type": "int",
              "min": 32,
              "max": 600,
              "step": 1,
              "default": 384,
              "unit": "samples"
            },
            {
              "name": "depth",
              "type": "int",
              "min": 16,
              "max": 360,
              "step": 1,
              "default": 192,
              "unit": "samples"
            },
            {
              "name": "rate",
              "type": "float",
              "min": 0.05,
              "max": 8,
              "step": 0.05,
              "default": 0.5,
              "unit": "Hz"
            }
          ],
          "note": "The library uses half the 1536-sample delay line: offset + depth must stay below 768 (the firmware clamps)."
        }
      ]
    },
    {
      "type": "AudioEffectDelay",
      "label": "Delay",
      "category": "time",
      "inputs": 1,
      "outputs": 8,
      "chain": true,
      "params": [
        {
          "method": "delay",
          "label": "Tap time",
          "args": [
            {
              "name": "channel",
              "type": "int",
              "min": 0,
              "max": 7,
              "step": 1,
              "default": 0
            },
            {
              "name": "time",
              "type": "float",
              "min": 0,
              "max": 1000,
              "step": 1,
              "default": 350,
              "unit": "ms"
            }
          ],
          "note": "Total delay across taps shares the AudioMemory pool (~1 s budget)."
        },
        {
          "method": "disable",
          "label": "Disable tap",
          "args": [
            {
              "name": "channel",
              "type": "int",
              "min": 0,
              "max": 7,
              "step": 1,
              "default": 1
            }
          ]
        }
      ]
    },
    {
      "type": "AudioEffectBitcrusher",
      "label": "Bitcrusher",
      "category": "lo-fi",
      "inputs": 1,
      "outputs": 1,
      "chain": true,
      "params": [
        {
          "method": "bits",
          "label": "Bit depth",
          "args": [
            {
              "name": "bits",
              "type": "int",
              "min": 1,
              "max": 16,
              "step": 1,
              "default": 8
            }
          ]
        },
        {
          "method": "sampleRate",
          "label": "Sample rate",
          "args": [
            {
              "name": "hz",
              "type": "float",
              "min": 1000,
              "max": 44100,
              "step": 100,
              "default": 11025,
              "scale": "log",
              "unit": "Hz"
            }
          ]
        }
      ]
    },
    {
      "type": "AudioEffectWaveshaper",
      "label": "Overdrive (waveshaper)",
      "category": "drive",
      "inputs": 1,
      "outputs": 1,
      "chain": true,
      "params": [
        {
          "method": "drive",
          "label": "Drive",
          "args": [
            {
              "name": "amount",
              "type": "float",
              "min": 1,
              "max": 10,
              "step": 0.1,
              "default": 3
            }
          ],
          "note": "PatchScript extension: builds a 257-point tanh curve in firmware."
        }
      ]
    },
    {
      "type": "AudioEffectGranular",
      "label": "Granular / Pitch",
      "category": "texture",
      "inputs": 1,
      "outputs": 1,
      "chain": true,
      "params": [
        {
          "method": "begin",
          "label": "Grain buffer",
          "once": true,
          "args": [
            {
              "name": "length",
              "type": "float",
              "min": 20,
              "max": 400,
              "step": 5,
              "default": 200,
              "unit": "ms"
            }
          ],
          "note": "PatchScript extension: firmware allocates the sample buffer."
        },
        {
          "method": "beginPitchShift",
          "label": "Pitch-shift grain",
          "args": [
            {
              "name": "grain",
              "type": "float",
              "min": 20,
              "max": 400,
              "step": 5,
              "default": 100,
              "unit": "ms"
            }
          ]
        },
        {
          "method": "beginFreeze",
          "label": "Freeze grain",
          "args": [
            {
              "name": "grain",
              "type": "float",
              "min": 20,
              "max": 400,
              "step": 5,
              "default": 100,
              "unit": "ms"
            }
          ]
        },
        {
          "method": "setSpeed",
          "label": "Speed / pitch ratio",
          "args": [
            {
              "name": "ratio",
              "type": "float",
              "min": 0.125,
              "max": 8,
              "step": 0.005,
              "default": 1.0,
              "scale": "log"
            }
          ]
        },
        {
          "method": "stop",
          "label": "Stop",
          "args": []
        }
      ]
    },
    {
      "type": "AudioEffectEnvelope",
      "label": "Envelope",
      "category": "dynamics",
      "inputs": 1,
      "outputs": 1,
      "chain": false,
      "params": [
        {
          "method": "attack",
          "label": "Attack",
          "args": [
            {
              "name": "ms",
              "type": "float",
              "min": 0,
              "max": 2000,
              "step": 1,
              "default": 10,
              "unit": "ms"
            }
          ]
        },
        {
          "method": "hold",
          "label": "Hold",
          "args": [
            {
              "name": "ms",
              "type": "float",
              "min": 0,
              "max": 2000,
              "step": 1,
              "default": 0,
              "unit": "ms"
            }
          ]
        },
        {
          "method": "decay",
          "label": "Decay",
          "args": [
            {
              "name": "ms",
              "type": "float",
              "min": 0,
              "max": 2000,
              "step": 1,
              "default": 35,
              "unit": "ms"
            }
          ]
        },
        {
          "method": "sustain",
          "label": "Sustain",
          "args": [
            {
              "name": "level",
              "type": "float",
              "min": 0,
              "max": 1,
              "step": 0.01,
              "default": 1
            }
          ]
        },
        {
          "method": "release",
          "label": "Release",
          "args": [
            {
              "name": "ms",
              "type": "float",
              "min": 0,
              "max": 5000,
              "step": 1,
              "default": 300,
              "unit": "ms"
            }
          ]
        },
        {
          "method": "noteOn",
          "label": "Trigger",
          "args": []
        },
        {
          "method": "noteOff",
          "label": "Release note",
          "args": []
        }
      ]
    },
    {
      "type": "AudioEffectMultiply",
      "label": "Multiply (ring/tremolo)",
      "category": "utility",
      "inputs": 2,
      "outputs": 1,
      "chain": false,
      "params": []
    },
    {
      "type": "AudioEffectRectifier",
      "label": "Rectifier (octave-up fuzz)",
      "category": "drive",
      "inputs": 1,
      "outputs": 1,
      "chain": true,
      "params": []
    },
    {
      "type": "AudioEffectWaveFolder",
      "label": "Wavefolder",
      "category": "drive",
      "inputs": 2,
      "outputs": 1,
      "chain": false,
      "params": []
    },
    {
      "type": "AudioEffectDigitalCombine",
      "label": "Digital combine",
      "category": "lo-fi",
      "inputs": 2,
      "outputs": 1,
      "chain": false,
      "params": [
        {
          "method": "setCombineMode",
          "label": "Mode",
          "args": [
            {
              "name": "mode",
              "type": "token",
              "tokens": [
                "OR",
                "XOR",
                "AND",
                "MODULO"
              ],
              "default": "XOR"
            }
          ]
        }
      ]
    },
    {
      "type": "AudioFilterBiquad",
      "label": "EQ filter (biquad)",
      "category": "filter",
      "inputs": 1,
      "outputs": 1,
      "chain": true,
      "params": [
        {
          "method": "setLowpass",
          "label": "Low-pass",
          "args": [
            {
              "name": "stage",
              "type": "int",
              "min": 0,
              "max": 3,
              "step": 1,
              "default": 0
            },
            {
              "name": "frequency",
              "type": "float",
              "min": 20,
              "max": 20000,
              "step": 1,
              "default": 4000,
              "scale": "log",
              "unit": "Hz"
            },
            {
              "name": "q",
              "type": "float",
              "min": 0.1,
              "max": 10,
              "step": 0.05,
              "default": 0.707
            }
          ]
        },
        {
          "method": "setHighpass",
          "label": "High-pass",
          "args": [
            {
              "name": "stage",
              "type": "int",
              "min": 0,
              "max": 3,
              "step": 1,
              "default": 0
            },
            {
              "name": "frequency",
              "type": "float",
              "min": 20,
              "max": 20000,
              "step": 1,
              "default": 120,
              "scale": "log",
              "unit": "Hz"
            },
            {
              "name": "q",
              "type": "float",
              "min": 0.1,
              "max": 10,
              "step": 0.05,
              "default": 0.707
            }
          ]
        },
        {
          "method": "setBandpass",
          "label": "Band-pass",
          "args": [
            {
              "name": "stage",
              "type": "int",
              "min": 0,
              "max": 3,
              "step": 1,
              "default": 0
            },
            {
              "name": "frequency",
              "type": "float",
              "min": 20,
              "max": 20000,
              "step": 1,
              "default": 800,
              "scale": "log",
              "unit": "Hz"
            },
            {
              "name": "q",
              "type": "float",
              "min": 0.1,
              "max": 10,
              "step": 0.05,
              "default": 1.0
            }
          ]
        },
        {
          "method": "setNotch",
          "label": "Notch",
          "args": [
            {
              "name": "stage",
              "type": "int",
              "min": 0,
              "max": 3,
              "step": 1,
              "default": 0
            },
            {
              "name": "frequency",
              "type": "float",
              "min": 20,
              "max": 20000,
              "step": 1,
              "default": 1000,
              "scale": "log",
              "unit": "Hz"
            },
            {
              "name": "q",
              "type": "float",
              "min": 0.1,
              "max": 10,
              "step": 0.05,
              "default": 1.0
            }
          ]
        },
        {
          "method": "setLowShelf",
          "label": "Low shelf",
          "args": [
            {
              "name": "stage",
              "type": "int",
              "min": 0,
              "max": 3,
              "step": 1,
              "default": 0
            },
            {
              "name": "frequency",
              "type": "float",
              "min": 20,
              "max": 20000,
              "step": 1,
              "default": 200,
              "scale": "log",
              "unit": "Hz"
            },
            {
              "name": "gain",
              "type": "float",
              "min": -24,
              "max": 24,
              "step": 0.5,
              "default": 3,
              "unit": "dB"
            },
            {
              "name": "slope",
              "type": "float",
              "min": 0.1,
              "max": 1,
              "step": 0.05,
              "default": 1
            }
          ]
        },
        {
          "method": "setHighShelf",
          "label": "High shelf",
          "args": [
            {
              "name": "stage",
              "type": "int",
              "min": 0,
              "max": 3,
              "step": 1,
              "default": 0
            },
            {
              "name": "frequency",
              "type": "float",
              "min": 20,
              "max": 20000,
              "step": 1,
              "default": 4000,
              "scale": "log",
              "unit": "Hz"
            },
            {
              "name": "gain",
              "type": "float",
              "min": -24,
              "max": 24,
              "step": 0.5,
              "default": 3,
              "unit": "dB"
            },
            {
              "name": "slope",
              "type": "float",
              "min": 0.1,
              "max": 1,
              "step": 0.05,
              "default": 1
            }
          ]
        }
      ]
    },
    {
      "type": "AudioFilterStateVariable",
      "label": "State-variable filter",
      "category": "filter",
      "inputs": 2,
      "outputs": 3,
      "chain": true,
      "outputNames": [
        "lowpass",
        "bandpass",
        "highpass"
      ],
      "params": [
        {
          "method": "frequency",
          "label": "Frequency",
          "args": [
            {
              "name": "hz",
              "type": "float",
              "min": 20,
              "max": 10000,
              "step": 1,
              "default": 1000,
              "scale": "log",
              "unit": "Hz"
            }
          ]
        },
        {
          "method": "resonance",
          "label": "Resonance",
          "args": [
            {
              "name": "q",
              "type": "float",
              "min": 0.7,
              "max": 5,
              "step": 0.05,
              "default": 0.7
            }
          ]
        },
        {
          "method": "octaveControl",
          "label": "Octave control range",
          "args": [
            {
              "name": "octaves",
              "type": "float",
              "min": 0,
              "max": 7,
              "step": 0.1,
              "default": 1
            }
          ]
        }
      ]
    },
    {
      "type": "AudioFilterLadder",
      "label": "Ladder filter (Moog-style)",
      "category": "filter",
      "inputs": 3,
      "outputs": 1,
      "chain": true,
      "params": [
        {
          "method": "frequency",
          "label": "Cutoff",
          "args": [
            {
              "name": "hz",
              "type": "float",
              "min": 20,
              "max": 20000,
              "step": 1,
              "default": 1200,
              "scale": "log",
              "unit": "Hz"
            }
          ]
        },
        {
          "method": "resonance",
          "label": "Resonance",
          "args": [
            {
              "name": "amount",
              "type": "float",
              "min": 0,
              "max": 1.8,
              "step": 0.01,
              "default": 0.7
            }
          ]
        },
        {
          "method": "octaveControl",
          "label": "Octave control range",
          "args": [
            {
              "name": "octaves",
              "type": "float",
              "min": 0,
              "max": 7,
              "step": 0.1,
              "default": 1
            }
          ]
        },
        {
          "method": "inputDrive",
          "label": "Input drive",
          "args": [
            {
              "name": "drive",
              "type": "float",
              "min": 0,
              "max": 4,
              "step": 0.05,
              "default": 1
            }
          ]
        }
      ]
    },
    {
      "type": "AudioSynthWaveform",
      "label": "LFO / oscillator",
      "category": "source",
      "inputs": 0,
      "outputs": 1,
      "chain": false,
      "params": [
        {
          "method": "begin",
          "label": "Start",
          "once": true,
          "args": [
            {
              "name": "level",
              "type": "float",
              "min": 0,
              "max": 1,
              "step": 0.01,
              "default": 0.5
            },
            {
              "name": "frequency",
              "type": "float",
              "min": 0.05,
              "max": 20000,
              "step": 0.05,
              "default": 4,
              "scale": "log",
              "unit": "Hz"
            },
            {
              "name": "shape",
              "type": "token",
              "tokens": [
                "WAVEFORM_SINE",
                "WAVEFORM_SAWTOOTH",
                "WAVEFORM_SQUARE",
                "WAVEFORM_TRIANGLE",
                "WAVEFORM_PULSE",
                "WAVEFORM_SAWTOOTH_REVERSE",
                "WAVEFORM_SAMPLE_HOLD",
                "WAVEFORM_TRIANGLE_VARIABLE"
              ],
              "default": "WAVEFORM_SINE"
            }
          ]
        },
        {
          "method": "amplitude",
          "label": "Level",
          "args": [
            {
              "name": "level",
              "type": "float",
              "min": 0,
              "max": 1,
              "step": 0.01,
              "default": 0.5
            }
          ]
        },
        {
          "method": "frequency",
          "label": "Frequency",
          "args": [
            {
              "name": "hz",
              "type": "float",
              "min": 0.05,
              "max": 20000,
              "step": 0.05,
              "default": 4,
              "scale": "log",
              "unit": "Hz"
            }
          ]
        },
        {
          "method": "pulseWidth",
          "label": "Pulse width",
          "args": [
            {
              "name": "width",
              "type": "float",
              "min": 0,
              "max": 1,
              "step": 0.01,
              "default": 0.5
            }
          ]
        }
      ]
    },
    {
      "type": "AudioSynthWaveformSine",
      "label": "Sine oscillator",
      "category": "source",
      "inputs": 0,
      "outputs": 1,
      "chain": false,
      "params": [
        {
          "method": "frequency",
          "label": "Frequency",
          "args": [
            {
              "name": "hz",
              "type": "float",
              "min": 0.05,
              "max": 20000,
              "step": 0.05,
              "default": 440,
              "scale": "log",
              "unit": "Hz"
            }
          ]
        },
        {
          "method": "amplitude",
          "label": "Level",
          "args": [
            {
              "name": "level",
              "type": "float",
              "min": 0,
              "max": 1,
              "step": 0.01,
              "default": 0.5
            }
          ]
        }
      ]
    },
    {
      "type": "AudioSynthWaveformDc",
      "label": "DC offset",
      "category": "source",
      "inputs": 0,
      "outputs": 1,
      "chain": false,
      "params": [
        {
          "method": "amplitude",
          "label": "Level",
          "args": [
            {
              "name": "level",
              "type": "float",
              "min": -1,
              "max": 1,
              "step": 0.01,
              "default": 0.5
            }
          ]
        }
      ]
    },
    {
      "type": "AudioSynthNoiseWhite",
      "label": "White noise",
      "category": "source",
      "inputs": 0,
      "outputs": 1,
      "chain": false,
      "params": [
        {
          "method": "amplitude",
          "label": "Level",
          "args": [
            {
              "name": "level",
              "type": "float",
              "min": 0,
              "max": 1,
              "step": 0.01,
              "default": 0.3
            }
          ]
        }
      ]
    },
    {
      "type": "AudioSynthNoisePink",
      "label": "Pink noise",
      "category": "source",
      "inputs": 0,
      "outputs": 1,
      "chain": false,
      "params": [
        {
          "method": "amplitude",
          "label": "Level",
          "args": [
            {
              "name": "level",
              "type": "float",
              "min": 0,
              "max": 1,
              "step": 0.01,
              "default": 0.3
            }
          ]
        }
      ]
    },
    {
      "type": "AudioSynthKarplusStrong",
      "label": "Plucked string",
      "category": "instrument",
      "inputs": 0,
      "outputs": 1,
      "chain": false,
      "instrument": true,
      "params": [
        {
          "method": "noteOn",
          "label": "Pluck",
          "args": [
            {
              "name": "frequency",
              "type": "float",
              "min": 20,
              "max": 5000,
              "step": 1,
              "default": 220,
              "scale": "log",
              "unit": "Hz"
            },
            {
              "name": "velocity",
              "type": "float",
              "min": 0,
              "max": 1,
              "step": 0.01,
              "default": 0.8
            }
          ]
        },
        {
          "method": "noteOff",
          "label": "Damp",
          "args": []
        }
      ]
    },
    {
      "type": "AudioSynthSimpleDrum",
      "label": "Drum",
      "category": "instrument",
      "inputs": 0,
      "outputs": 1,
      "chain": false,
      "instrument": true,
      "params": [
        {
          "method": "frequency",
          "label": "Pitch",
          "args": [
            {
              "name": "hz",
              "type": "float",
              "min": 20,
              "max": 2000,
              "step": 1,
              "default": 60,
              "scale": "log",
              "unit": "Hz"
            }
          ]
        },
        {
          "method": "length",
          "label": "Length",
          "args": [
            {
              "name": "ms",
              "type": "float",
              "min": 10,
              "max": 2000,
              "step": 5,
              "default": 200,
              "unit": "ms"
            }
          ]
        },
        {
          "method": "secondMix",
          "label": "Second harmonic",
          "args": [
            {
              "name": "mix",
              "type": "float",
              "min": 0,
              "max": 1,
              "step": 0.01,
              "default": 0
            }
          ]
        },
        {
          "method": "pitchMod",
          "label": "Pitch drop",
          "args": [
            {
              "name": "amount",
              "type": "float",
              "min": 0,
              "max": 1,
              "step": 0.01,
              "default": 0.5
            }
          ]
        },
        {
          "method": "noteOn",
          "label": "Hit",
          "args": []
        }
      ]
    },
    {
      "type": "AudioSynthWaveformModulated",
      "label": "VCO (modulated oscillator)",
      "category": "source",
      "inputs": 2,
      "outputs": 1,
      "chain": false,
      "params": [
        {
          "method": "begin",
          "label": "Start",
          "once": true,
          "args": [
            {
              "name": "level",
              "type": "float",
              "min": 0,
              "max": 1,
              "step": 0.01,
              "default": 0.5
            },
            {
              "name": "frequency",
              "type": "float",
              "min": 0.05,
              "max": 20000,
              "step": 0.05,
              "default": 220,
              "scale": "log",
              "unit": "Hz"
            },
            {
              "name": "shape",
              "type": "token",
              "tokens": [
                "WAVEFORM_SINE",
                "WAVEFORM_SAWTOOTH",
                "WAVEFORM_SQUARE",
                "WAVEFORM_TRIANGLE",
                "WAVEFORM_PULSE",
                "WAVEFORM_SAWTOOTH_REVERSE",
                "WAVEFORM_SAMPLE_HOLD",
                "WAVEFORM_TRIANGLE_VARIABLE"
              ],
              "default": "WAVEFORM_SAWTOOTH"
            }
          ]
        },
        {
          "method": "amplitude",
          "label": "Level",
          "args": [
            {
              "name": "level",
              "type": "float",
              "min": 0,
              "max": 1,
              "step": 0.01,
              "default": 0.5
            }
          ]
        },
        {
          "method": "frequency",
          "label": "Frequency",
          "args": [
            {
              "name": "hz",
              "type": "float",
              "min": 0.05,
              "max": 20000,
              "step": 0.05,
              "default": 220,
              "scale": "log",
              "unit": "Hz"
            }
          ]
        },
        {
          "method": "frequencyModulation",
          "label": "FM range",
          "args": [
            {
              "name": "octaves",
              "type": "float",
              "min": 0,
              "max": 12,
              "step": 0.1,
              "default": 1
            }
          ]
        },
        {
          "method": "phaseModulation",
          "label": "PM range",
          "args": [
            {
              "name": "degrees",
              "type": "float",
              "min": 0,
              "max": 9000,
              "step": 10,
              "default": 0
            }
          ]
        }
      ]
    },
    {
      "type": "AudioSynthWaveformPWM",
      "label": "PWM oscillator",
      "category": "source",
      "inputs": 1,
      "outputs": 1,
      "chain": false,
      "params": [
        {
          "method": "amplitude",
          "label": "Level",
          "args": [
            {
              "name": "level",
              "type": "float",
              "min": 0,
              "max": 1,
              "step": 0.01,
              "default": 0.5
            }
          ]
        },
        {
          "method": "frequency",
          "label": "Frequency",
          "args": [
            {
              "name": "hz",
              "type": "float",
              "min": 0.05,
              "max": 20000,
              "step": 0.05,
              "default": 220,
              "scale": "log",
              "unit": "Hz"
            }
          ]
        }
      ]
    },
    {
      "type": "AudioSynthToneSweep",
      "label": "Tone sweep",
      "category": "instrument",
      "inputs": 0,
      "outputs": 1,
      "chain": false,
      "params": [
        {
          "method": "play",
          "label": "Play (amp, from Hz, to Hz, ms)",
          "args": [
            {
              "name": "amplitude",
              "type": "float",
              "min": 0,
              "max": 1,
              "step": 0.01,
              "default": 0.5
            },
            {
              "name": "from",
              "type": "float",
              "min": 20,
              "max": 20000,
              "step": 1,
              "default": 800
            },
            {
              "name": "to",
              "type": "float",
              "min": 20,
              "max": 20000,
              "step": 1,
              "default": 80
            },
            {
              "name": "ms",
              "type": "float",
              "min": 10,
              "max": 5000,
              "step": 1,
              "default": 150
            }
          ]
        }
      ]
    },
    {
      "type": "AudioPlaySdWav",
      "label": "Sample (WAV from the SD card)",
      "category": "instrument",
      "inputs": 0,
      "outputs": 2,
      "chain": false,
      "params": [
        {
          "method": "stop",
          "label": "Stop",
          "args": []
        }
      ]
    }
  ],
  "macros": [
    {
      "id": "echo",
      "label": "Echo (delay + feedback)",
      "note": "Editor macro: expands to AudioMixer4 + AudioEffectDelay in a feedback loop.",
      "params": [
        {
          "name": "time",
          "min": 20,
          "max": 1000,
          "step": 1,
          "default": 350,
          "unit": "ms"
        },
        {
          "name": "feedback",
          "min": 0,
          "max": 0.9,
          "step": 0.01,
          "default": 0.4
        },
        {
          "name": "mix",
          "min": 0,
          "max": 1,
          "step": 0.01,
          "default": 0.5
        }
      ]
    },
    {
      "id": "tremolo",
      "label": "Tremolo",
      "note": "Editor macro: LFO sine + DC offset summed into AudioEffectMultiply.",
      "params": [
        {
          "name": "rate",
          "min": 0.5,
          "max": 15,
          "step": 0.1,
          "default": 5,
          "unit": "Hz"
        },
        {
          "name": "depth",
          "min": 0,
          "max": 1,
          "step": 0.01,
          "default": 0.5
        }
      ]
    },
    {
      "id": "pluck",
      "label": "Plucked string (poly)",
      "note": "Editor instrument: N AudioSynthKarplusStrong voices (groups v1..vN), mixed, MIDI-bound.",
      "params": [
        {
          "name": "voices",
          "min": 1,
          "max": 4,
          "step": 1,
          "default": 2
        },
        {
          "name": "channel",
          "min": 0,
          "max": 16,
          "step": 1,
          "default": 1
        },
        {
          "name": "level",
          "min": 0,
          "max": 1,
          "step": 0.01,
          "default": 0.8
        }
      ],
      "template": {
        "family": "keys",
        "perVoice": true,
        "objects": [
          {
            "n": "ks",
            "type": "AudioSynthKarplusStrong"
          }
        ],
        "conns": [],
        "out": "ks",
        "set": [],
        "midi": [
          "ks"
        ],
        "levelDiv": "voices"
      }
    },
    {
      "id": "synth",
      "label": "Synth (osc + envelope, poly)",
      "note": "Editor instrument: N AudioSynthWaveform + AudioEffectEnvelope pairs (one group per pair), mixed, MIDI-bound.",
      "params": [
        {
          "name": "voices",
          "min": 1,
          "max": 4,
          "step": 1,
          "default": 2
        },
        {
          "name": "channel",
          "min": 0,
          "max": 16,
          "step": 1,
          "default": 1
        },
        {
          "name": "shape",
          "tokens": [
            "WAVEFORM_SAWTOOTH",
            "WAVEFORM_SQUARE",
            "WAVEFORM_TRIANGLE",
            "WAVEFORM_SINE",
            "WAVEFORM_PULSE"
          ],
          "default": "WAVEFORM_SAWTOOTH"
        },
        {
          "name": "level",
          "min": 0,
          "max": 1,
          "step": 0.01,
          "default": 0.4
        },
        {
          "name": "attack",
          "min": 0,
          "max": 2000,
          "step": 1,
          "default": 5,
          "unit": "ms"
        },
        {
          "name": "decay",
          "min": 0,
          "max": 2000,
          "step": 1,
          "default": 120,
          "unit": "ms"
        },
        {
          "name": "sustain",
          "min": 0,
          "max": 1,
          "step": 0.01,
          "default": 0.7
        },
        {
          "name": "release",
          "min": 0,
          "max": 5000,
          "step": 1,
          "default": 250,
          "unit": "ms"
        }
      ],
      "template": {
        "family": "keys",
        "perVoice": true,
        "objects": [
          {
            "n": "osc",
            "type": "AudioSynthWaveform"
          },
          {
            "n": "env",
            "type": "AudioEffectEnvelope"
          }
        ],
        "conns": [
          [
            "osc",
            0,
            "env",
            0
          ]
        ],
        "out": "env",
        "set": [
          "osc.begin({level}, 220, {shape})",
          "env.attack({attack})",
          "env.decay({decay})",
          "env.sustain({sustain})",
          "env.release({release})"
        ],
        "midi": [
          "osc",
          "env"
        ],
        "velocity": {
          "osc": 0.7
        }
      }
    },
    {
      "id": "fmbell",
      "label": "FM bell",
      "note": "Editor instrument: Sine carrier frequency-modulated by a sine at a ratio, with a percussive envelope: bells, mallets, glassy keys.",
      "params": [
        {
          "name": "voices",
          "min": 1,
          "max": 4,
          "step": 1,
          "default": 2
        },
        {
          "name": "channel",
          "min": 0,
          "max": 16,
          "step": 1,
          "default": 1
        },
        {
          "name": "ratio",
          "min": 0.5,
          "max": 8,
          "step": 0.5,
          "default": 3.5,
          "label": "Modulator ratio"
        },
        {
          "name": "index",
          "min": 0,
          "max": 6,
          "step": 0.05,
          "default": 1.8,
          "label": "FM depth"
        },
        {
          "name": "level",
          "min": 0,
          "max": 1,
          "step": 0.01,
          "default": 0.5
        },
        {
          "name": "attack",
          "min": 0,
          "max": 500,
          "step": 1,
          "default": 2,
          "unit": "ms"
        },
        {
          "name": "decay",
          "min": 50,
          "max": 5000,
          "step": 10,
          "default": 900,
          "unit": "ms"
        },
        {
          "name": "sustain",
          "min": 0,
          "max": 1,
          "step": 0.01,
          "default": 0.0
        },
        {
          "name": "release",
          "min": 0,
          "max": 5000,
          "step": 10,
          "default": 1200,
          "unit": "ms"
        }
      ],
      "template": {
        "family": "keys",
        "perVoice": true,
        "objects": [
          {
            "n": "mod",
            "type": "AudioSynthWaveformSine"
          },
          {
            "n": "car",
            "type": "AudioSynthWaveformModulated"
          },
          {
            "n": "env",
            "type": "AudioEffectEnvelope"
          }
        ],
        "conns": [
          [
            "mod",
            0,
            "car",
            0
          ],
          [
            "car",
            0,
            "env",
            0
          ]
        ],
        "out": "env",
        "set": [
          "mod.amplitude({index:/6})",
          "car.begin({level}, 440, WAVEFORM_SINE)",
          "car.frequencyModulation(6)",
          "env.attack({attack})",
          "env.decay({decay})",
          "env.sustain({sustain})",
          "env.release({release})"
        ],
        "midi": [
          "mod",
          "car",
          "env"
        ],
        "ratio": {
          "mod": "{ratio}"
        },
        "velocity": {
          "car": 0.8
        }
      }
    },
    {
      "id": "epiano",
      "label": "FM electric piano",
      "note": "Editor instrument: Two-operator FM with a fast bite and a long tail - a classic tine piano.",
      "params": [
        {
          "name": "voices",
          "min": 1,
          "max": 4,
          "step": 1,
          "default": 2
        },
        {
          "name": "channel",
          "min": 0,
          "max": 16,
          "step": 1,
          "default": 1
        },
        {
          "name": "bite",
          "min": 0,
          "max": 1,
          "step": 0.01,
          "default": 0.55,
          "label": "Bite"
        },
        {
          "name": "level",
          "min": 0,
          "max": 1,
          "step": 0.01,
          "default": 0.5
        },
        {
          "name": "decay",
          "min": 100,
          "max": 6000,
          "step": 10,
          "default": 2500,
          "unit": "ms"
        },
        {
          "name": "release",
          "min": 0,
          "max": 3000,
          "step": 10,
          "default": 400,
          "unit": "ms"
        }
      ],
      "template": {
        "family": "keys",
        "perVoice": true,
        "objects": [
          {
            "n": "mod",
            "type": "AudioSynthWaveformSine"
          },
          {
            "n": "car",
            "type": "AudioSynthWaveformModulated"
          },
          {
            "n": "env",
            "type": "AudioEffectEnvelope"
          }
        ],
        "conns": [
          [
            "mod",
            0,
            "car",
            0
          ],
          [
            "car",
            0,
            "env",
            0
          ]
        ],
        "out": "env",
        "set": [
          "mod.amplitude({bite:*0.25})",
          "car.begin({level}, 440, WAVEFORM_SINE)",
          "car.frequencyModulation(4)",
          "env.attack(1)",
          "env.decay({decay})",
          "env.sustain(0.15)",
          "env.release({release})"
        ],
        "midi": [
          "mod",
          "car",
          "env"
        ],
        "ratio": {
          "mod": "1"
        },
        "velocity": {
          "car": 0.9
        }
      }
    },
    {
      "id": "organ",
      "label": "Organ",
      "note": "Editor instrument: Three sine drawbars (fundamental, octave, twelfth) through a click-free envelope.",
      "params": [
        {
          "name": "voices",
          "min": 1,
          "max": 4,
          "step": 1,
          "default": 2
        },
        {
          "name": "channel",
          "min": 0,
          "max": 16,
          "step": 1,
          "default": 1
        },
        {
          "name": "drawbar8",
          "min": 0,
          "max": 1,
          "step": 0.01,
          "default": 0.8,
          "label": "8' drawbar"
        },
        {
          "name": "drawbar4",
          "min": 0,
          "max": 1,
          "step": 0.01,
          "default": 0.5,
          "label": "4' drawbar"
        },
        {
          "name": "drawbar223",
          "min": 0,
          "max": 1,
          "step": 0.01,
          "default": 0.3,
          "label": "2 2/3' drawbar"
        },
        {
          "name": "level",
          "min": 0,
          "max": 1,
          "step": 0.01,
          "default": 0.4
        }
      ],
      "template": {
        "family": "keys",
        "perVoice": true,
        "objects": [
          {
            "n": "s1",
            "type": "AudioSynthWaveformSine"
          },
          {
            "n": "s2",
            "type": "AudioSynthWaveformSine"
          },
          {
            "n": "s3",
            "type": "AudioSynthWaveformSine"
          },
          {
            "n": "omix",
            "type": "AudioMixer4"
          },
          {
            "n": "env",
            "type": "AudioEffectEnvelope"
          }
        ],
        "conns": [
          [
            "s1",
            0,
            "omix",
            0
          ],
          [
            "s2",
            0,
            "omix",
            1
          ],
          [
            "s3",
            0,
            "omix",
            2
          ],
          [
            "omix",
            0,
            "env",
            0
          ]
        ],
        "out": "env",
        "set": [
          "s1.amplitude({drawbar8})",
          "s2.amplitude({drawbar4})",
          "s3.amplitude({drawbar223})",
          "omix.gain(0, {level:*0.5})",
          "omix.gain(1, {level:*0.5})",
          "omix.gain(2, {level:*0.5})",
          "env.attack(8)",
          "env.decay(0)",
          "env.sustain(1)",
          "env.release(60)"
        ],
        "midi": [
          "s1",
          "s2",
          "s3",
          "env"
        ],
        "ratio": {
          "s2": "2",
          "s3": "3"
        }
      }
    },
    {
      "id": "bass",
      "label": "Synth bass",
      "note": "Editor instrument: Sawtooth into a Moog-style ladder filter with an envelope - fat, round bass.",
      "params": [
        {
          "name": "voices",
          "min": 1,
          "max": 2,
          "step": 1,
          "default": 1
        },
        {
          "name": "channel",
          "min": 0,
          "max": 16,
          "step": 1,
          "default": 1
        },
        {
          "name": "cutoff",
          "min": 100,
          "max": 8000,
          "step": 10,
          "default": 900,
          "unit": "Hz"
        },
        {
          "name": "resonance",
          "min": 0,
          "max": 1.5,
          "step": 0.05,
          "default": 0.6
        },
        {
          "name": "level",
          "min": 0,
          "max": 1,
          "step": 0.01,
          "default": 0.6
        },
        {
          "name": "attack",
          "min": 0,
          "max": 200,
          "step": 1,
          "default": 3,
          "unit": "ms"
        },
        {
          "name": "decay",
          "min": 0,
          "max": 2000,
          "step": 10,
          "default": 350,
          "unit": "ms"
        },
        {
          "name": "sustain",
          "min": 0,
          "max": 1,
          "step": 0.01,
          "default": 0.5
        },
        {
          "name": "release",
          "min": 0,
          "max": 2000,
          "step": 10,
          "default": 150,
          "unit": "ms"
        }
      ],
      "template": {
        "family": "keys",
        "perVoice": true,
        "objects": [
          {
            "n": "osc",
            "type": "AudioSynthWaveform"
          },
          {
            "n": "lp",
            "type": "AudioFilterLadder"
          },
          {
            "n": "env",
            "type": "AudioEffectEnvelope"
          }
        ],
        "conns": [
          [
            "osc",
            0,
            "lp",
            0
          ],
          [
            "lp",
            0,
            "env",
            0
          ]
        ],
        "out": "env",
        "set": [
          "osc.begin({level}, 110, WAVEFORM_SAWTOOTH)",
          "lp.frequency({cutoff})",
          "lp.resonance({resonance})",
          "env.attack({attack})",
          "env.decay({decay})",
          "env.sustain({sustain})",
          "env.release({release})"
        ],
        "midi": [
          "osc",
          "env"
        ],
        "velocity": {
          "osc": 0.6
        }
      }
    },
    {
      "id": "subbass",
      "label": "Sub bass",
      "note": "Editor instrument: A sine an octave below the played note - the low end under a loop.",
      "params": [
        {
          "name": "voices",
          "min": 1,
          "max": 2,
          "step": 1,
          "default": 1
        },
        {
          "name": "channel",
          "min": 0,
          "max": 16,
          "step": 1,
          "default": 1
        },
        {
          "name": "level",
          "min": 0,
          "max": 1,
          "step": 0.01,
          "default": 0.7
        },
        {
          "name": "release",
          "min": 0,
          "max": 1000,
          "step": 10,
          "default": 120,
          "unit": "ms"
        }
      ],
      "template": {
        "family": "keys",
        "perVoice": true,
        "objects": [
          {
            "n": "osc",
            "type": "AudioSynthWaveformSine"
          },
          {
            "n": "env",
            "type": "AudioEffectEnvelope"
          }
        ],
        "conns": [
          [
            "osc",
            0,
            "env",
            0
          ]
        ],
        "out": "env",
        "set": [
          "osc.amplitude({level})",
          "env.attack(5)",
          "env.decay(0)",
          "env.sustain(1)",
          "env.release({release})"
        ],
        "midi": [
          "osc",
          "env"
        ],
        "ratio": {
          "osc": "0.5"
        }
      }
    },
    {
      "id": "lead",
      "label": "PWM lead",
      "note": "Editor instrument: A pulse wave whose width is swept by a slow triangle - the classic moving lead.",
      "params": [
        {
          "name": "voices",
          "min": 1,
          "max": 4,
          "step": 1,
          "default": 2
        },
        {
          "name": "channel",
          "min": 0,
          "max": 16,
          "step": 1,
          "default": 1
        },
        {
          "name": "speed",
          "min": 0.1,
          "max": 8,
          "step": 0.1,
          "default": 0.8,
          "unit": "Hz",
          "label": "Sweep speed"
        },
        {
          "name": "depth",
          "min": 0,
          "max": 1,
          "step": 0.01,
          "default": 0.5,
          "label": "Sweep depth"
        },
        {
          "name": "level",
          "min": 0,
          "max": 1,
          "step": 0.01,
          "default": 0.5
        },
        {
          "name": "attack",
          "min": 0,
          "max": 2000,
          "step": 1,
          "default": 5,
          "unit": "ms"
        },
        {
          "name": "decay",
          "min": 0,
          "max": 2000,
          "step": 1,
          "default": 120,
          "unit": "ms"
        },
        {
          "name": "sustain",
          "min": 0,
          "max": 1,
          "step": 0.01,
          "default": 0.7
        },
        {
          "name": "release",
          "min": 0,
          "max": 5000,
          "step": 1,
          "default": 250,
          "unit": "ms"
        }
      ],
      "template": {
        "family": "keys",
        "perVoice": true,
        "objects": [
          {
            "n": "lfo",
            "type": "AudioSynthWaveform"
          },
          {
            "n": "osc",
            "type": "AudioSynthWaveformPWM"
          },
          {
            "n": "env",
            "type": "AudioEffectEnvelope"
          }
        ],
        "conns": [
          [
            "lfo",
            0,
            "osc",
            0
          ],
          [
            "osc",
            0,
            "env",
            0
          ]
        ],
        "out": "env",
        "set": [
          "lfo.begin({depth}, {speed}, WAVEFORM_TRIANGLE)",
          "osc.amplitude({level})",
          "env.attack({attack})",
          "env.decay({decay})",
          "env.sustain({sustain})",
          "env.release({release})"
        ],
        "midi": [
          "osc",
          "env"
        ],
        "velocity": {
          "osc": 0.6
        }
      }
    },
    {
      "id": "pad",
      "label": "Detuned pad",
      "note": "Editor instrument: Two sawtooths a few cents apart, slow attack and release - wide, slow chords.",
      "params": [
        {
          "name": "voices",
          "min": 1,
          "max": 3,
          "step": 1,
          "default": 2
        },
        {
          "name": "channel",
          "min": 0,
          "max": 16,
          "step": 1,
          "default": 1
        },
        {
          "name": "detune",
          "min": 0,
          "max": 30,
          "step": 1,
          "default": 9,
          "unit": "cents"
        },
        {
          "name": "level",
          "min": 0,
          "max": 1,
          "step": 0.01,
          "default": 0.35
        },
        {
          "name": "attack",
          "min": 0,
          "max": 4000,
          "step": 10,
          "default": 700,
          "unit": "ms"
        },
        {
          "name": "release",
          "min": 0,
          "max": 6000,
          "step": 10,
          "default": 1800,
          "unit": "ms"
        }
      ],
      "template": {
        "family": "keys",
        "perVoice": true,
        "objects": [
          {
            "n": "a",
            "type": "AudioSynthWaveform"
          },
          {
            "n": "b",
            "type": "AudioSynthWaveform"
          },
          {
            "n": "pmix",
            "type": "AudioMixer4"
          },
          {
            "n": "env",
            "type": "AudioEffectEnvelope"
          }
        ],
        "conns": [
          [
            "a",
            0,
            "pmix",
            0
          ],
          [
            "b",
            0,
            "pmix",
            1
          ],
          [
            "pmix",
            0,
            "env",
            0
          ]
        ],
        "out": "env",
        "set": [
          "a.begin({level}, 220, WAVEFORM_SAWTOOTH)",
          "b.begin({level}, 220, WAVEFORM_SAWTOOTH)",
          "pmix.gain(0, 0.5)",
          "pmix.gain(1, 0.5)",
          "env.attack({attack})",
          "env.decay(0)",
          "env.sustain(1)",
          "env.release({release})"
        ],
        "midi": [
          "a",
          "b",
          "env"
        ],
        "ratio": {
          "b": "{detune:cents}"
        }
      }
    },
    {
      "id": "strings",
      "label": "Strings",
      "note": "Editor instrument: Sawtooth through a gentle low-pass with a bowed envelope - a section, not a solo.",
      "params": [
        {
          "name": "voices",
          "min": 1,
          "max": 4,
          "step": 1,
          "default": 2
        },
        {
          "name": "channel",
          "min": 0,
          "max": 16,
          "step": 1,
          "default": 1
        },
        {
          "name": "brightness",
          "min": 200,
          "max": 6000,
          "step": 10,
          "default": 1800,
          "unit": "Hz"
        },
        {
          "name": "level",
          "min": 0,
          "max": 1,
          "step": 0.01,
          "default": 0.4
        },
        {
          "name": "attack",
          "min": 0,
          "max": 3000,
          "step": 10,
          "default": 350,
          "unit": "ms"
        },
        {
          "name": "release",
          "min": 0,
          "max": 4000,
          "step": 10,
          "default": 900,
          "unit": "ms"
        }
      ],
      "template": {
        "family": "keys",
        "perVoice": true,
        "objects": [
          {
            "n": "osc",
            "type": "AudioSynthWaveform"
          },
          {
            "n": "lp",
            "type": "AudioFilterStateVariable"
          },
          {
            "n": "env",
            "type": "AudioEffectEnvelope"
          }
        ],
        "conns": [
          [
            "osc",
            0,
            "lp",
            0
          ],
          [
            "lp",
            0,
            "env",
            0
          ]
        ],
        "out": "env",
        "set": [
          "osc.begin({level}, 220, WAVEFORM_SAWTOOTH)",
          "lp.frequency({brightness})",
          "lp.resonance(0.9)",
          "env.attack({attack})",
          "env.decay(0)",
          "env.sustain(1)",
          "env.release({release})"
        ],
        "midi": [
          "osc",
          "env"
        ],
        "velocity": {
          "osc": 0.5
        }
      }
    },
    {
      "id": "square",
      "label": "Chip lead",
      "note": "Editor instrument: A square wave with a snappy envelope - 8-bit leads and arpeggios.",
      "params": [
        {
          "name": "voices",
          "min": 1,
          "max": 4,
          "step": 1,
          "default": 2
        },
        {
          "name": "channel",
          "min": 0,
          "max": 16,
          "step": 1,
          "default": 1
        },
        {
          "name": "width",
          "min": 0.05,
          "max": 0.95,
          "step": 0.05,
          "default": 0.5,
          "label": "Pulse width"
        },
        {
          "name": "level",
          "min": 0,
          "max": 1,
          "step": 0.01,
          "default": 0.4
        },
        {
          "name": "decay",
          "min": 0,
          "max": 2000,
          "step": 10,
          "default": 200,
          "unit": "ms"
        },
        {
          "name": "sustain",
          "min": 0,
          "max": 1,
          "step": 0.01,
          "default": 0.4
        },
        {
          "name": "release",
          "min": 0,
          "max": 2000,
          "step": 10,
          "default": 80,
          "unit": "ms"
        }
      ],
      "template": {
        "family": "keys",
        "perVoice": true,
        "objects": [
          {
            "n": "osc",
            "type": "AudioSynthWaveform"
          },
          {
            "n": "env",
            "type": "AudioEffectEnvelope"
          }
        ],
        "conns": [
          [
            "osc",
            0,
            "env",
            0
          ]
        ],
        "out": "env",
        "set": [
          "osc.begin({level}, 440, WAVEFORM_PULSE)",
          "osc.pulseWidth({width})",
          "env.attack(1)",
          "env.decay({decay})",
          "env.sustain({sustain})",
          "env.release({release})"
        ],
        "midi": [
          "osc",
          "env"
        ],
        "velocity": {
          "osc": 0.5
        }
      }
    },
    {
      "id": "wind",
      "label": "Wind / noise",
      "note": "Editor instrument: Pink noise through a resonant band-pass tracked to the note, with a slow envelope: breath, wind, shakers when short.",
      "params": [
        {
          "name": "voices",
          "min": 1,
          "max": 2,
          "step": 1,
          "default": 1
        },
        {
          "name": "channel",
          "min": 0,
          "max": 16,
          "step": 1,
          "default": 1
        },
        {
          "name": "resonance",
          "min": 0.7,
          "max": 5,
          "step": 0.1,
          "default": 3.5
        },
        {
          "name": "level",
          "min": 0,
          "max": 1,
          "step": 0.01,
          "default": 0.5
        },
        {
          "name": "attack",
          "min": 0,
          "max": 3000,
          "step": 10,
          "default": 400,
          "unit": "ms"
        },
        {
          "name": "release",
          "min": 0,
          "max": 4000,
          "step": 10,
          "default": 600,
          "unit": "ms"
        }
      ],
      "template": {
        "family": "keys",
        "perVoice": true,
        "objects": [
          {
            "n": "nz",
            "type": "AudioSynthNoisePink"
          },
          {
            "n": "bp",
            "type": "AudioFilterStateVariable"
          },
          {
            "n": "env",
            "type": "AudioEffectEnvelope"
          }
        ],
        "conns": [
          [
            "nz",
            0,
            "bp",
            0
          ],
          [
            "bp",
            1,
            "env",
            0
          ]
        ],
        "out": "env",
        "set": [
          "nz.amplitude({level})",
          "bp.frequency(800)",
          "bp.resonance({resonance})",
          "env.attack({attack})",
          "env.decay(0)",
          "env.sustain(1)",
          "env.release({release})"
        ],
        "midi": [
          "bp",
          "env"
        ]
      }
    },
    {
      "id": "zap",
      "label": "Sweep / zap",
      "note": "Editor instrument: A tone sweep fired on every note - lasers, drops and risers (the note sets the start pitch).",
      "params": [
        {
          "name": "voices",
          "min": 1,
          "max": 2,
          "step": 1,
          "default": 1
        },
        {
          "name": "channel",
          "min": 0,
          "max": 16,
          "step": 1,
          "default": 1
        },
        {
          "name": "to",
          "min": 20,
          "max": 20000,
          "step": 10,
          "default": 60,
          "unit": "Hz",
          "label": "Sweep to"
        },
        {
          "name": "ms",
          "min": 10,
          "max": 3000,
          "step": 10,
          "default": 180,
          "unit": "ms",
          "label": "Sweep time"
        },
        {
          "name": "level",
          "min": 0,
          "max": 1,
          "step": 0.01,
          "default": 0.5
        }
      ],
      "template": {
        "family": "keys",
        "perVoice": true,
        "objects": [
          {
            "n": "sw",
            "type": "AudioSynthToneSweep"
          }
        ],
        "conns": [],
        "out": "sw",
        "set": [
          "sw.sweep({level}, 880, {to}, {ms})"
        ],
        "midi": [
          "sw"
        ]
      }
    },
    {
      "id": "drumkit",
      "label": "Drum kit (kick · snare · hat)",
      "note": "Editor instrument: three AudioSynthSimpleDrum voices on channel 10 bound to notes 36/38/42, mixed.",
      "params": [
        {
          "name": "level",
          "min": 0,
          "max": 1,
          "step": 0.01,
          "default": 0.8
        },
        {
          "name": "channel",
          "label": "MIDI channel",
          "min": 1,
          "max": 16,
          "step": 1,
          "default": 10,
          "note": "Which MIDI channel the kit answers. 10 is the General MIDI drum channel."
        }
      ],
      "template": {
        "family": "pads",
        "channel": 10,
        "pads": [
          {
            "n": "kick",
            "label": "KICK",
            "note": 36,
            "objects": [
              {
                "n": "d",
                "type": "AudioSynthSimpleDrum"
              }
            ],
            "conns": [],
            "out": "d",
            "set": [
              "d.frequency(60)",
              "d.length(300)",
              "d.pitchMod(0.6)"
            ],
            "midi": [
              "d"
            ],
            "gain": 0.5
          },
          {
            "n": "snare",
            "label": "SNARE",
            "note": 38,
            "objects": [
              {
                "n": "d",
                "type": "AudioSynthSimpleDrum"
              }
            ],
            "conns": [],
            "out": "d",
            "set": [
              "d.frequency(180)",
              "d.length(150)",
              "d.secondMix(0.5)"
            ],
            "midi": [
              "d"
            ],
            "gain": 0.5
          },
          {
            "n": "hat",
            "label": "HAT",
            "note": 42,
            "objects": [
              {
                "n": "d",
                "type": "AudioSynthSimpleDrum"
              }
            ],
            "conns": [],
            "out": "d",
            "set": [
              "d.frequency(800)",
              "d.length(60)"
            ],
            "midi": [
              "d"
            ],
            "gain": 0.5
          }
        ]
      }
    },
    {
      "id": "kit808",
      "label": "808 kit",
      "note": "Editor instrument: Eight electronic drums: kick, snare, clap, closed and open hats, low and high toms, cowbell - GM notes on channel 10.",
      "params": [
        {
          "name": "level",
          "min": 0,
          "max": 1,
          "step": 0.01,
          "default": 0.8
        },
        {
          "name": "decay",
          "min": 50,
          "max": 1500,
          "step": 10,
          "default": 400,
          "unit": "ms",
          "label": "Kick decay"
        },
        {
          "name": "channel",
          "label": "MIDI channel",
          "min": 1,
          "max": 16,
          "step": 1,
          "default": 10,
          "note": "Which MIDI channel the kit answers. 10 is the General MIDI drum channel."
        }
      ],
      "template": {
        "family": "pads",
        "channel": 10,
        "pads": [
          {
            "n": "kick",
            "label": "KICK",
            "note": 36,
            "objects": [
              {
                "n": "d",
                "type": "AudioSynthSimpleDrum"
              }
            ],
            "conns": [],
            "out": "d",
            "set": [
              "d.frequency(48)",
              "d.length({decay})",
              "d.pitchMod(0.8)"
            ],
            "midi": [
              "d"
            ],
            "gain": 0.6
          },
          {
            "n": "snare",
            "label": "SNARE",
            "note": 38,
            "objects": [
              {
                "n": "d",
                "type": "AudioSynthSimpleDrum"
              },
              {
                "n": "nz",
                "type": "AudioSynthNoiseWhite"
              },
              {
                "n": "env",
                "type": "AudioEffectEnvelope"
              },
              {
                "n": "m",
                "type": "AudioMixer4"
              }
            ],
            "conns": [
              [
                "d",
                0,
                "m",
                0
              ],
              [
                "nz",
                0,
                "env",
                0
              ],
              [
                "env",
                0,
                "m",
                1
              ]
            ],
            "out": "m",
            "set": [
              "d.frequency(170)",
              "d.length(120)",
              "d.secondMix(0.3)",
              "nz.amplitude(0.5)",
              "env.attack(1)",
              "env.decay(110)",
              "env.sustain(0)",
              "env.release(40)",
              "m.gain(0, 0.7)",
              "m.gain(1, 0.5)"
            ],
            "midi": [
              "d",
              "env"
            ],
            "gain": 0.5
          },
          {
            "n": "clap",
            "label": "CLAP",
            "note": 39,
            "objects": [
              {
                "n": "nz",
                "type": "AudioSynthNoiseWhite"
              },
              {
                "n": "bp",
                "type": "AudioFilterStateVariable"
              },
              {
                "n": "env",
                "type": "AudioEffectEnvelope"
              }
            ],
            "conns": [
              [
                "nz",
                0,
                "bp",
                0
              ],
              [
                "bp",
                1,
                "env",
                0
              ]
            ],
            "out": "env",
            "set": [
              "nz.amplitude(0.6)",
              "bp.frequency(1400)",
              "bp.resonance(1.5)",
              "env.attack(2)",
              "env.hold(12)",
              "env.decay(160)",
              "env.sustain(0)",
              "env.release(60)"
            ],
            "midi": [
              "env"
            ],
            "gain": 0.5
          },
          {
            "n": "chh",
            "label": "HAT",
            "note": 42,
            "objects": [
              {
                "n": "nz",
                "type": "AudioSynthNoiseWhite"
              },
              {
                "n": "hp",
                "type": "AudioFilterStateVariable"
              },
              {
                "n": "env",
                "type": "AudioEffectEnvelope"
              }
            ],
            "conns": [
              [
                "nz",
                0,
                "hp",
                0
              ],
              [
                "hp",
                2,
                "env",
                0
              ]
            ],
            "out": "env",
            "set": [
              "nz.amplitude(0.4)",
              "hp.frequency(7000)",
              "hp.resonance(0.8)",
              "env.attack(1)",
              "env.decay(45)",
              "env.sustain(0)",
              "env.release(20)"
            ],
            "midi": [
              "env"
            ],
            "gain": 0.4
          },
          {
            "n": "ohh",
            "label": "OPEN HAT",
            "note": 46,
            "objects": [
              {
                "n": "nz",
                "type": "AudioSynthNoiseWhite"
              },
              {
                "n": "hp",
                "type": "AudioFilterStateVariable"
              },
              {
                "n": "env",
                "type": "AudioEffectEnvelope"
              }
            ],
            "conns": [
              [
                "nz",
                0,
                "hp",
                0
              ],
              [
                "hp",
                2,
                "env",
                0
              ]
            ],
            "out": "env",
            "set": [
              "nz.amplitude(0.4)",
              "hp.frequency(6000)",
              "hp.resonance(0.8)",
              "env.attack(1)",
              "env.decay(300)",
              "env.sustain(0)",
              "env.release(200)"
            ],
            "midi": [
              "env"
            ],
            "gain": 0.4
          },
          {
            "n": "ltom",
            "label": "LOW TOM",
            "note": 45,
            "objects": [
              {
                "n": "d",
                "type": "AudioSynthSimpleDrum"
              }
            ],
            "conns": [],
            "out": "d",
            "set": [
              "d.frequency(90)",
              "d.length(260)",
              "d.pitchMod(0.5)"
            ],
            "midi": [
              "d"
            ],
            "gain": 0.5
          },
          {
            "n": "htom",
            "label": "HIGH TOM",
            "note": 50,
            "objects": [
              {
                "n": "d",
                "type": "AudioSynthSimpleDrum"
              }
            ],
            "conns": [],
            "out": "d",
            "set": [
              "d.frequency(160)",
              "d.length(200)",
              "d.pitchMod(0.5)"
            ],
            "midi": [
              "d"
            ],
            "gain": 0.5
          },
          {
            "n": "bell",
            "label": "COWBELL",
            "note": 56,
            "objects": [
              {
                "n": "a",
                "type": "AudioSynthWaveform"
              },
              {
                "n": "b",
                "type": "AudioSynthWaveform"
              },
              {
                "n": "m",
                "type": "AudioMixer4"
              },
              {
                "n": "env",
                "type": "AudioEffectEnvelope"
              }
            ],
            "conns": [
              [
                "a",
                0,
                "m",
                0
              ],
              [
                "b",
                0,
                "m",
                1
              ],
              [
                "m",
                0,
                "env",
                0
              ]
            ],
            "out": "env",
            "set": [
              "a.begin(0.4, 587, WAVEFORM_SQUARE)",
              "b.begin(0.4, 845, WAVEFORM_SQUARE)",
              "m.gain(0, 0.5)",
              "m.gain(1, 0.5)",
              "env.attack(1)",
              "env.decay(180)",
              "env.sustain(0)",
              "env.release(60)"
            ],
            "midi": [
              "env"
            ],
            "gain": 0.4
          }
        ]
      }
    },
    {
      "id": "perc",
      "label": "Percussion",
      "note": "Editor instrument: Congas, bongos, a rim and a shaker from tuned drum voices and noise - GM notes 60-70 on channel 10.",
      "params": [
        {
          "name": "level",
          "min": 0,
          "max": 1,
          "step": 0.01,
          "default": 0.8
        },
        {
          "name": "channel",
          "label": "MIDI channel",
          "min": 1,
          "max": 16,
          "step": 1,
          "default": 10,
          "note": "Which MIDI channel the kit answers. 10 is the General MIDI drum channel."
        }
      ],
      "template": {
        "family": "pads",
        "channel": 10,
        "pads": [
          {
            "n": "congalo",
            "label": "CONGA L",
            "note": 64,
            "objects": [
              {
                "n": "d",
                "type": "AudioSynthSimpleDrum"
              }
            ],
            "conns": [],
            "out": "d",
            "set": [
              "d.frequency(190)",
              "d.length(220)",
              "d.pitchMod(0.25)"
            ],
            "midi": [
              "d"
            ],
            "gain": 0.5
          },
          {
            "n": "congahi",
            "label": "CONGA H",
            "note": 63,
            "objects": [
              {
                "n": "d",
                "type": "AudioSynthSimpleDrum"
              }
            ],
            "conns": [],
            "out": "d",
            "set": [
              "d.frequency(260)",
              "d.length(170)",
              "d.pitchMod(0.25)"
            ],
            "midi": [
              "d"
            ],
            "gain": 0.5
          },
          {
            "n": "bongo",
            "label": "BONGO",
            "note": 60,
            "objects": [
              {
                "n": "d",
                "type": "AudioSynthSimpleDrum"
              }
            ],
            "conns": [],
            "out": "d",
            "set": [
              "d.frequency(420)",
              "d.length(90)",
              "d.pitchMod(0.2)"
            ],
            "midi": [
              "d"
            ],
            "gain": 0.5
          },
          {
            "n": "rim",
            "label": "RIM",
            "note": 37,
            "objects": [
              {
                "n": "d",
                "type": "AudioSynthSimpleDrum"
              }
            ],
            "conns": [],
            "out": "d",
            "set": [
              "d.frequency(900)",
              "d.length(35)",
              "d.secondMix(0.7)"
            ],
            "midi": [
              "d"
            ],
            "gain": 0.4
          },
          {
            "n": "shaker",
            "label": "SHAKER",
            "note": 70,
            "objects": [
              {
                "n": "nz",
                "type": "AudioSynthNoisePink"
              },
              {
                "n": "hp",
                "type": "AudioFilterStateVariable"
              },
              {
                "n": "env",
                "type": "AudioEffectEnvelope"
              }
            ],
            "conns": [
              [
                "nz",
                0,
                "hp",
                0
              ],
              [
                "hp",
                2,
                "env",
                0
              ]
            ],
            "out": "env",
            "set": [
              "nz.amplitude(0.5)",
              "hp.frequency(4000)",
              "hp.resonance(0.7)",
              "env.attack(8)",
              "env.decay(70)",
              "env.sustain(0)",
              "env.release(30)"
            ],
            "midi": [
              "env"
            ],
            "gain": 0.4
          }
        ]
      }
    },
    {
      "id": "samples",
      "label": "Sample pads (WAV from the card)",
      "note": "Editor instrument: Up to four one-shot pads playing /samples/<name>.wav from the SD card (16-bit 44.1 kHz WAV) - real drums, hits, anything.",
      "params": [
        {
          "name": "level",
          "min": 0,
          "max": 1,
          "step": 0.01,
          "default": 0.8
        },
        {
          "name": "pad1",
          "text": true,
          "default": "kick",
          "label": "Pad 1 file"
        },
        {
          "name": "pad2",
          "text": true,
          "default": "snare",
          "label": "Pad 2 file"
        },
        {
          "name": "pad3",
          "text": true,
          "default": "hat",
          "label": "Pad 3 file"
        },
        {
          "name": "pad4",
          "text": true,
          "default": "",
          "label": "Pad 4 file"
        },
        {
          "name": "channel",
          "label": "MIDI channel",
          "min": 1,
          "max": 16,
          "step": 1,
          "default": 10,
          "note": "Which MIDI channel the kit answers. 10 is the General MIDI drum channel."
        }
      ],
      "template": {
        "family": "pads",
        "channel": 10,
        "pads": [
          {
            "n": "p1",
            "label": "PAD 1",
            "note": 36,
            "objects": [
              {
                "n": "w",
                "type": "AudioPlaySdWav"
              }
            ],
            "conns": [],
            "out": "w",
            "set": [
              "w.file({pad1})"
            ],
            "midi": [
              "w"
            ],
            "gain": 0.7,
            "if": "pad1"
          },
          {
            "n": "p2",
            "label": "PAD 2",
            "note": 38,
            "objects": [
              {
                "n": "w",
                "type": "AudioPlaySdWav"
              }
            ],
            "conns": [],
            "out": "w",
            "set": [
              "w.file({pad2})"
            ],
            "midi": [
              "w"
            ],
            "gain": 0.7,
            "if": "pad2"
          },
          {
            "n": "p3",
            "label": "PAD 3",
            "note": 42,
            "objects": [
              {
                "n": "w",
                "type": "AudioPlaySdWav"
              }
            ],
            "conns": [],
            "out": "w",
            "set": [
              "w.file({pad3})"
            ],
            "midi": [
              "w"
            ],
            "gain": 0.7,
            "if": "pad3"
          },
          {
            "n": "p4",
            "label": "PAD 4",
            "note": 49,
            "objects": [
              {
                "n": "w",
                "type": "AudioPlaySdWav"
              }
            ],
            "conns": [],
            "out": "w",
            "set": [
              "w.file({pad4})"
            ],
            "midi": [
              "w"
            ],
            "gain": 0.7,
            "if": "pad4"
          }
        ]
      }
    }
  ],
  "midiBindable": [
    "AudioSynthKarplusStrong",
    "AudioSynthSimpleDrum",
    "AudioSynthWaveform",
    "AudioSynthWaveformSine",
    "AudioSynthWaveformModulated",
    "AudioSynthWaveformPWM",
    "AudioEffectEnvelope",
    "AudioFilterStateVariable",
    "AudioSynthToneSweep",
    "AudioPlaySdWav"
  ],
  "midiBinding": {
    "method": "midi",
    "args": [
      {
        "name": "channel",
        "type": "int",
        "min": 0,
        "max": 16,
        "default": 1
      },
      {
        "name": "group",
        "type": "ident"
      },
      {
        "name": "note",
        "type": "int",
        "min": 0,
        "max": 127,
        "optional": true
      }
    ],
    "note": "PatchScript extension, see PATCHSCRIPT.md — binds the object as a MIDI voice.",
    "extensions": {
      "midiRatio(x)": "multiply the note frequency for this object (FM modulators, detune, sub-octaves)",
      "midiVelocity(s)": "velocity sensitivity 0..1 for oscillators: amplitude = base * (1 - s + s * velocity)",
      "sweep(amp, fromHz, toHz, ms)": "AudioSynthToneSweep: what each trigger plays",
      "file(name)": "AudioPlaySdWav: /samples/<name>.wav played on each trigger"
    }
  },
  "limits": {
    "objects": 48,
    "connections": 96
  }
}
;
/* --- END effects-schema.json --- */

