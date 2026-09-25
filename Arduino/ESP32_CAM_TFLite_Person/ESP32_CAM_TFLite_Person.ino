#include <Arduino.h>
#include "esp_camera.h"
#include "esp_heap_caps.h"

#include "config.h"

#include "tensorflow/lite/micro/micro_interpreter.h"
#include "tensorflow/lite/micro/micro_mutable_op_resolver.h"
#include "tensorflow/lite/schema/schema_generated.h"

#include "person_detect_model_data.h"


// ============================================================
// AI Thinker ESP32-CAM pin configuration
// ============================================================

#define PWDN_GPIO_NUM     32
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM      0
#define SIOD_GPIO_NUM     26
#define SIOC_GPIO_NUM     27

#define Y9_GPIO_NUM       35
#define Y8_GPIO_NUM       34
#define Y7_GPIO_NUM       39
#define Y6_GPIO_NUM       36
#define Y5_GPIO_NUM       21
#define Y4_GPIO_NUM       19
#define Y3_GPIO_NUM       18
#define Y2_GPIO_NUM        5

#define VSYNC_GPIO_NUM    25
#define HREF_GPIO_NUM     23
#define PCLK_GPIO_NUM     22


// ============================================================
// Model parameters
// ============================================================

constexpr int IMAGE_WIDTH  = 96;
constexpr int IMAGE_HEIGHT = 96;
constexpr int IMAGE_CHANNELS = 1;
constexpr int IMAGE_SIZE =
    IMAGE_WIDTH * IMAGE_HEIGHT * IMAGE_CHANNELS;


// ============================================================
// TFLite Micro globals
// ============================================================

const tflite::Model *model = nullptr;

tflite::MicroInterpreter *interpreter = nullptr;

TfLiteTensor *input = nullptr;

uint8_t *tensor_arena = nullptr;


// ============================================================
// Detection state
// ============================================================

bool personDetected = false;


// ============================================================
// Camera initialization
// ============================================================

bool initCamera()
{
    camera_config_t config;

    config.ledc_channel = LEDC_CHANNEL_0;
    config.ledc_timer   = LEDC_TIMER_0;

    config.pin_d0 = Y2_GPIO_NUM;
    config.pin_d1 = Y3_GPIO_NUM;
    config.pin_d2 = Y4_GPIO_NUM;
    config.pin_d3 = Y5_GPIO_NUM;
    config.pin_d4 = Y6_GPIO_NUM;
    config.pin_d5 = Y7_GPIO_NUM;
    config.pin_d6 = Y8_GPIO_NUM;
    config.pin_d7 = Y9_GPIO_NUM;

    config.pin_xclk = XCLK_GPIO_NUM;
    config.pin_pclk = PCLK_GPIO_NUM;
    config.pin_vsync = VSYNC_GPIO_NUM;
    config.pin_href = HREF_GPIO_NUM;

    config.pin_sccb_sda = SIOD_GPIO_NUM;
    config.pin_sccb_scl = SIOC_GPIO_NUM;

    config.pin_pwdn = PWDN_GPIO_NUM;
    config.pin_reset = RESET_GPIO_NUM;

    config.xclk_freq_hz = 15000000;

    // The v1.3.3 model expects 96x96 grayscale input.
    config.pixel_format = PIXFORMAT_GRAYSCALE;
    config.frame_size = FRAMESIZE_96X96;

    config.jpeg_quality = 12;

    // Only one frame is needed.
    config.fb_count = 1;
    config.fb_location = CAMERA_FB_IN_PSRAM;
    config.grab_mode = CAMERA_GRAB_WHEN_EMPTY;

    esp_err_t err = esp_camera_init(&config);

    if (err != ESP_OK)
    {
        Serial.printf(
            "Camera init failed: 0x%x\n",
            err
        );

        return false;
    }

    // AI Thinker camera is mounted upside-down.
    sensor_t *sensor = esp_camera_sensor_get();

    if (sensor)
    {
        sensor->set_vflip(sensor, 1);
    }

    return true;
}


// ============================================================
// TFLite Micro initialization
// ============================================================

bool initTFLite()
{
    // The official v1.3.3 example allocates the tensor arena
    // from internal RAM.
    tensor_arena = (uint8_t *)heap_caps_malloc(
        TENSOR_ARENA_SIZE,
        MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT
    );

    if (!tensor_arena)
    {
        Serial.println(
            "ERROR: Could not allocate tensor arena"
        );

        return false;
    }

#if PRINT_STARTUP_INFO
    Serial.printf(
        "Tensor arena: %d bytes\n",
        TENSOR_ARENA_SIZE
    );
#endif


    // --------------------------------------------------------
    // Load model
    // --------------------------------------------------------

    model = tflite::GetModel(
        g_person_detect_model_data
    );

    if (model->version() != TFLITE_SCHEMA_VERSION)
    {
        Serial.printf(
            "ERROR: Model schema version %d, expected %d\n",
            model->version(),
            TFLITE_SCHEMA_VERSION
        );

        return false;
    }


    // --------------------------------------------------------
    // Register only the operators required by this model.
    //
    // These are the same five operators used by Espressif's
    // v1.3.3 person-detection example.
    // --------------------------------------------------------

    static tflite::MicroMutableOpResolver<5> resolver;

    resolver.AddAveragePool2D();
    resolver.AddConv2D();
    resolver.AddDepthwiseConv2D();
    resolver.AddReshape();
    resolver.AddSoftmax();


    // --------------------------------------------------------
    // Create interpreter
    // --------------------------------------------------------

    static tflite::MicroInterpreter static_interpreter(
        model,
        resolver,
        tensor_arena,
        TENSOR_ARENA_SIZE
    );

    interpreter = &static_interpreter;


    // --------------------------------------------------------
    // Allocate model tensors
    // --------------------------------------------------------

    if (interpreter->AllocateTensors() != kTfLiteOk)
    {
        Serial.println(
            "ERROR: AllocateTensors() failed"
        );

        return false;
    }


    // --------------------------------------------------------
    // Get model input
    // --------------------------------------------------------

    input = interpreter->input(0);

#if PRINT_STARTUP_INFO
    Serial.printf(
        "Model input: %d x %d x %d\n",
        input->dims->data[1],
        input->dims->data[2],
        input->dims->data[3]
    );
#endif

    return true;
}


// ============================================================
// GPIO / detection state
// ============================================================

void setPersonDetected(bool detected)
{
    // Avoid repeatedly calling digitalWrite() when the state
    // has not changed.
    if (detected == personDetected)
    {
        return;
    }

    personDetected = detected;

    digitalWrite(
        PERSON_DETECTED_GPIO,
        personDetected ? HIGH : LOW
    );

    if (personDetected)
    {
        Serial.println(
            ">>> PERSON DETECTED - GPIO HIGH <<<"
        );
    }
    else
    {
        Serial.println(
            ">>> NO PERSON - GPIO LOW <<<"
        );
    }
}


// ============================================================
// Run one camera + inference cycle
// ============================================================

bool detectPerson(
    float &personScore,
    float &noPersonScore
)
{
    // --------------------------------------------------------
    // Capture camera frame
    // --------------------------------------------------------

    camera_fb_t *fb = esp_camera_fb_get();

    if (!fb)
    {
        Serial.println(
            "ERROR: Camera capture failed"
        );

        return false;
    }


    // --------------------------------------------------------
    // Verify frame dimensions
    // --------------------------------------------------------

    if (
        fb->width != IMAGE_WIDTH ||
        fb->height != IMAGE_HEIGHT
    )
    {
        Serial.printf(
            "ERROR: Unexpected frame size: %dx%d\n",
            fb->width,
            fb->height
        );

        esp_camera_fb_return(fb);

        return false;
    }


    // --------------------------------------------------------
    // Convert camera uint8 pixels to model int8 input.
    //
    // This follows the v1.3.3 implementation:
    //
    //     uint8 -> int8
    //
    // by flipping the high bit.
    // --------------------------------------------------------

    for (int i = 0; i < IMAGE_SIZE; i++)
    {
        input->data.int8[i] =
            ((uint8_t *)fb->buf)[i] ^ 0x80;
    }


    // Frame buffer is no longer needed.
    esp_camera_fb_return(fb);


    // --------------------------------------------------------
    // Run neural network
    // --------------------------------------------------------

    if (interpreter->Invoke() != kTfLiteOk)
    {
        Serial.println(
            "ERROR: TFLite Invoke() failed"
        );

        return false;
    }


    // --------------------------------------------------------
    // Get output
    //
    // v1.3.3 model:
    //
    //   index 0 = no person
    //   index 1 = person
    // --------------------------------------------------------

    TfLiteTensor *output =
        interpreter->output(0);


    int8_t person =
        output->data.int8[1];

    int8_t noPerson =
        output->data.int8[0];


    // --------------------------------------------------------
    // Convert quantized values to floating point scores.
    //
    // This is the same quantization calculation used by
    // Espressif's v1.3.3 example.
    // --------------------------------------------------------

    personScore =
        (person - output->params.zero_point)
        * output->params.scale;

    noPersonScore =
        (noPerson - output->params.zero_point)
        * output->params.scale;


    return true;
}


// ============================================================
// Arduino setup()
// ============================================================

void setup()
{
    Serial.begin(115200);

    delay(2000);

    Serial.println();
    Serial.println("==============================");
    Serial.println("ESP32-CAM TFLite Micro");
    Serial.println("Person Detection v1.3.3");
    Serial.println("==============================");


#if PRINT_STARTUP_INFO

    Serial.printf(
        "PSRAM: %s\n",
        psramFound() ? "YES" : "NO"
    );

    Serial.printf(
        "Free PSRAM: %u bytes\n",
        ESP.getFreePsram()
    );

    Serial.printf(
        "Detection GPIO: %d\n",
        PERSON_DETECTED_GPIO
    );

    Serial.printf(
        "Detection threshold: %.0f%%\n",
        PERSON_DETECTION_THRESHOLD * 100.0f
    );

    Serial.printf(
        "Clear threshold: %.0f%%\n",
        PERSON_CLEAR_THRESHOLD * 100.0f
    );

#endif


    // --------------------------------------------------------
    // GPIO
    // --------------------------------------------------------

    pinMode(
        PERSON_DETECTED_GPIO,
        OUTPUT
    );

    // Start in the safe "no person" state.
    digitalWrite(
        PERSON_DETECTED_GPIO,
        LOW
    );


    // --------------------------------------------------------
    // Camera
    // --------------------------------------------------------

    if (!initCamera())
    {
        Serial.println(
            "Camera initialization FAILED"
        );

        while (true)
        {
            delay(1000);
        }
    }

    Serial.println(
        "Camera initialized."
    );


    // --------------------------------------------------------
    // TFLite Micro
    // --------------------------------------------------------

    if (!initTFLite())
    {
        Serial.println(
            "TFLite initialization FAILED"
        );

        while (true)
        {
            delay(1000);
        }
    }


    Serial.println();
    Serial.println(
        "Detector ready."
    );
    Serial.println();
}


// ============================================================
// Arduino loop()
// ============================================================

void loop()
{
    float personScore = 0.0f;
    float noPersonScore = 0.0f;


    if (detectPerson(
        personScore,
        noPersonScore
    ))
    {

#if PRINT_DETECTION_SCORES

        Serial.printf(
            "Person: %3d%%   "
            "No person: %3d%%",
            (int)(
                personScore * 100.0f + 0.5f
            ),
            (int)(
                noPersonScore * 100.0f + 0.5f
            )
        );

#endif


        // ----------------------------------------------------
        // Detection hysteresis
        //
        // If currently OFF:
        //     turn ON at >= PERSON_DETECTION_THRESHOLD
        //
        // If currently ON:
        //     stay ON until score falls below
        //     PERSON_CLEAR_THRESHOLD
        // ----------------------------------------------------

        if (!personDetected)
        {
            if (
                personScore >=
                PERSON_DETECTION_THRESHOLD
            )
            {
#if PRINT_DETECTION_SCORES
                Serial.println(
                    "   -> DETECT"
                );
#endif

                setPersonDetected(true);
            }
            else
            {
#if PRINT_DETECTION_SCORES
                Serial.println();
#endif
            }
        }
        else
        {
            if (
                personScore <
                PERSON_CLEAR_THRESHOLD
            )
            {
#if PRINT_DETECTION_SCORES
                Serial.println(
                    "   -> CLEAR"
                );
#endif

                setPersonDetected(false);
            }
            else
            {
#if PRINT_DETECTION_SCORES
                Serial.println(
                    "   -> PERSON"
                );
#endif
            }
        }
    }


    // Give FreeRTOS a little breathing room.
    delay(DETECTION_LOOP_DELAY_MS);
}
