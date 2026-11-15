# Registers GoogleService-Info.plist and the push entitlements with the Xcode project.
# Safe to run more than once.
require "xcodeproj"

project = Xcodeproj::Project.open("ios/App/App.xcodeproj")
target = project.targets.find { |t| t.name == "App" }
group = project.main_group.find_subpath("App", false)

unless group.files.any? { |f| f.path == "GoogleService-Info.plist" }
  ref = group.new_reference("GoogleService-Info.plist")
  target.resources_build_phase.add_file_reference(ref)
end

unless group.files.any? { |f| f.path == "App.entitlements" }
  group.new_reference("App.entitlements")
end

target.build_configurations.each do |config|
  config.build_settings["CODE_SIGN_ENTITLEMENTS"] = "App/App.entitlements"
end

project.save
puts "Xcode project updated."
