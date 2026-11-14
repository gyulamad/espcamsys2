// setup_credentials.example.h — an optional build-time default master password (F-21).
//
// A board that has no master password of its own yet opens its setup WiFi with a built-in default
// ("Admin1234"), which is public: it is in the repository. If you would rather your boards never use
// that one, copy this file to
//
//     Arduino/ESP32_CAM_Recorder/setup_credentials.local.h
//     Arduino/ESP32_CAM_TFLite_Person/setup_credentials.local.h
//
// (git ignores *.local.h, so the password never reaches the repository), change the text below, and
// build as usual. The sketches pick the file up if it is there and use the built-in one if it is not.
//
// What it changes: the password of the setup WiFi of a board that is still on the default, and the
// password the form asks you to replace. It does not touch a board that has its own master password,
// and the form still refuses to keep the public built-in password either.
//
// 8 to 63 printable ASCII characters (a WPA2 passphrase); anything else stops the build with an error,
// because a passphrase the WiFi would refuse would leave a blank board without a setup WiFi at all.
// The text below is only a placeholder: choose your own.
#define SETUP_DEFAULT_PASSWORD_OVERRIDE "change-me-before-use"
