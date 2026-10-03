from pathlib import Path
import hashlib,re
root=Path(__file__).parent
project_file=root/'Fotoro.xcodeproj/project.pbxproj'
previous=project_file.read_text() if project_file.exists() else ''
build_match=re.search(r'CURRENT_PROJECT_VERSION = ([0-9]+);',previous)
version_match=re.search(r'MARKETING_VERSION = ([0-9.]+);',previous)
build_number=build_match.group(1) if build_match else '1'
marketing_version=version_match.group(1) if version_match else '0.1.0'
objects={}
def uid(s): return hashlib.sha1(s.encode()).hexdigest()[:24].upper()
def add(name,body): objects[uid(name)]=body;return uid(name)
def q(s): return '"'+s+'"'
files=[];build=[];resources=[];testfiles=[];testres=[];file_refs={}
for folder in ['Fotoro','FotoroTests']:
 for p in sorted((root/folder).rglob('*')):
  if any(parent.suffix=='.xcassets' for parent in p.parents):continue
  if not (p.is_file() or p.suffix=='.xcassets') or p.suffix in [".plist",".entitlements"]:continue
  rel=str(p.relative_to(root)); typ='folder.assetcatalog' if p.suffix=='.xcassets' else 'sourcecode.swift' if p.suffix=='.swift' else 'text.json' if p.suffix=='.json' else 'text.xml' if p.suffix=='.xcprivacy' else 'image.jpeg'
  f=add(rel,f'isa = PBXFileReference; lastKnownFileType = {typ}; path = {q(rel)}; sourceTree = SOURCE_ROOT;');files.append(f);file_refs[rel]=f
  b=add(rel+'build',f'isa = PBXBuildFile; fileRef = {f};')
  (testfiles if folder=='FotoroTests' and p.suffix=='.swift' else testres if folder=='FotoroTests' else build if p.suffix=='.swift' else resources).append(b)
products=[]; targets=[]
packages=[];deps=[];product_deps={}
for name,url,version in [('Sodium','https://github.com/jedisct1/swift-sodium.git','0.9.1'),('GRDB','https://github.com/groue/GRDB.swift.git','7.0.0'),('Nuke','https://github.com/kean/Nuke.git','12.8.0')]:
 ref=add(name+'pkg',f'isa = XCRemoteSwiftPackageReference; repositoryURL = {q(url)}; requirement = {{kind = upToNextMajorVersion; minimumVersion = {version};}};');packages.append(ref)
 for product in ([name,'NukeUI'] if name=='Nuke' else [name]):
  dep=add(product+'dep',f'isa = XCSwiftPackageProductDependency; package = {ref}; productName = {product};');deps.append(dep);product_deps[product]=dep
frameworks=[add(d+'build',f'isa = PBXBuildFile; productRef = {d};') for d in deps]
# Keep the local beta a separate build graph. New full-app files never silently
# enter this binary; changes to this allowlist require a new artifact audit.
def preview_files(paths, target):
 return [add(target+path+'build', f'isa = PBXBuildFile; fileRef = {file_refs[path]};') for path in paths]
preview_sources=preview_files([
 'Fotoro/FotoroApp.swift',
 'Fotoro/Library/RecentPhotosStore.swift',
 'Fotoro/Library/PhotoBrowsing.swift',
 'Fotoro/Library/AutomaticPhotoPicks.swift',
 'Fotoro/Library/PhotoPickAnalyzer.swift',
 'Fotoro/Library/RecentPhotosView.swift',
 'Fotoro/Search/LocalSearchStore.swift',
 'Fotoro/Search/LocalSearchView.swift',
 'Fotoro/Search/SearchIndex.swift',
 'Fotoro/Search/SearchModels.swift',
 'Fotoro/Search/NaturalDateQuery.swift',
 'Fotoro/Search/VisionTextProcessor.swift',
 'Fotoro/Support/FotoroError.swift',
], 'FotoroLocalPreview')
preview_resources=preview_files([
 'Fotoro/Resources/Assets.xcassets', 'Fotoro/PrivacyInfo.xcprivacy',
], 'FotoroLocalPreview')
preview_tests=preview_files([
 'FotoroTests/SearchTests.swift', 'FotoroTests/SearchStoreTests.swift',
 'FotoroTests/SearchPerformanceTests.swift', 'FotoroTests/SearchLifecycleTests.swift',
 'FotoroTests/VisualSearchTests.swift', 'FotoroTests/NaturalDateSearchTests.swift',
 'FotoroTests/LocalPreviewIsolationTests.swift',
 'FotoroTests/AutomaticPhotoPicksTests.swift', 'FotoroTests/PhotoPickLifecycleTests.swift',
 'FotoroTests/PhotoBrowsingTests.swift',
], 'FotoroLocalPreviewTests')
preview_test_resources=preview_files([
 'FotoroTests/search-cases.json', 'FotoroTests/neutral-a.png', 'FotoroTests/neutral-c.png',
], 'FotoroLocalPreviewTests')
preview_dependencies=[product_deps['GRDB']]
preview_frameworks=[add('previewGRDBbuild', f'isa = PBXBuildFile; productRef = {product_deps["GRDB"]};')]
definitions=[
 ('Fotoro',build,resources,'application',None,deps,frameworks),
 ('FotoroTests',testfiles,testres,'bundle.unit-test','Fotoro',[],[]),
 ('FotoroLocalPreview',preview_sources,preview_resources,'application',None,preview_dependencies,preview_frameworks),
 ('FotoroLocalPreviewTests',preview_tests,preview_test_resources,'bundle.unit-test','FotoroLocalPreview',[],[]),
]
for target,sources,res,ptype,host,target_deps,target_frameworks in definitions:
 app=ptype=='application'
 preview=target.startswith('FotoroLocalPreview')
 prod=add(target+'product',f'isa = PBXFileReference; explicitFileType = wrapper.{"application" if app else "cfbundle"}; path = {target}.{"app" if app else "xctest"}; sourceTree = BUILT_PRODUCTS_DIR;');products.append(prod)
 phases=[]
 for kind,items in [('Sources',sources),('Resources',res),('Frameworks',target_frameworks)]:phases.append(add(target+kind,f'isa = PBX{kind}BuildPhase; buildActionMask = 2147483647; files = ({",".join(items)}); runOnlyForDeploymentPostprocessing = 0;'))
 configs=[]
 for conf in ['Debug','Release']:
  bundle='cloud.fotoro.Fotoro' if app else 'cloud.fotoro.'+target
  settings='SDKROOT = iphoneos; IPHONEOS_DEPLOYMENT_TARGET = 26.0; SWIFT_VERSION = 5.0; TARGETED_DEVICE_FAMILY = "1,2"; GENERATE_INFOPLIST_FILE = YES; CODE_SIGN_STYLE = Automatic; PRODUCT_NAME = "$(TARGET_NAME)"; PRODUCT_BUNDLE_IDENTIFIER = '+bundle+'; MARKETING_VERSION = '+marketing_version+'; CURRENT_PROJECT_VERSION = '+build_number+'; '
  settings+='ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon; ' if app else ''
  if conf=='Debug':
   settings+='ENABLE_TESTABILITY = YES; ONLY_ACTIVE_ARCH = YES; SWIFT_OPTIMIZATION_LEVEL = "-Onone"; '
  conditions=(['DEBUG'] if conf=='Debug' else [])+(['FOTORO_LOCAL_PREVIEW'] if preview else [])
  if conditions: settings+='SWIFT_ACTIVE_COMPILATION_CONDITIONS = '+q(' '.join(conditions))+'; '
  if app:
   settings+='INFOPLIST_KEY_NSPhotoLibraryUsageDescription = "Browse your last 10 days of photos and share selected originals."; INFOPLIST_FILE = Fotoro/Info.plist; INFOPLIST_KEY_UILaunchScreen_Generation = YES; '
   if preview:
    settings+='PRODUCT_MODULE_NAME = Fotoro; INFOPLIST_KEY_CFBundleDisplayName = Fotoro; FOTORO_BUILD_MODE = "local-preview"; INFOPLIST_KEY_ITSAppUsesNonExemptEncryption = NO; '
   else: settings+='CODE_SIGN_ENTITLEMENTS = Fotoro/Fotoro.entitlements; FOTORO_BUILD_MODE = encrypted; '
  else:
   settings+='TEST_HOST = "$(BUILT_PRODUCTS_DIR)/'+host+'.app/$(BUNDLE_EXECUTABLE_FOLDER_PATH)/'+host+'"; BUNDLE_LOADER = "$(TEST_HOST)"; '
  configs.append(add(target+conf,f'isa = XCBuildConfiguration; name = {conf}; buildSettings = {{{settings}}};'))
 cl=add(target+'configs',f'isa = XCConfigurationList; buildConfigurations = ({",".join(configs)}); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release;')
 dependency=[]
 if host:
  proxy_name='proxy' if target=='FotoroTests' else target+'proxy'
  dependency_name='dependency' if target=='FotoroTests' else target+'dependency'
  proxy=add(proxy_name,f'isa = PBXContainerItemProxy; containerPortal = {uid("project")}; proxyType = 1; remoteGlobalIDString = {uid(host+"Target")}; remoteInfo = {host};')
  dependency=[add(dependency_name,f'isa = PBXTargetDependency; target = {uid(host+"Target")}; targetProxy = {proxy};')]
 targets.append(add(target+'Target',f'isa = PBXNativeTarget; buildConfigurationList = {cl}; buildPhases = ({",".join(phases)}); buildRules = (); dependencies = ({",".join(dependency)}); name = {target}; productName = {target}; productReference = {prod}; productType = "com.apple.product-type.{ptype}"; packageProductDependencies = ({",".join(target_deps)});'))
pg=add('products',f'isa = PBXGroup; children = ({",".join(products)}); name = Products; sourceTree = "<group>";')
group=add('group',f'isa = PBXGroup; children = ({",".join(files+[pg])}); sourceTree = "<group>";')
configs=[add('project'+c,f'isa = XCBuildConfiguration; name = {c}; buildSettings = {{CLANG_ENABLE_MODULES = YES;}};') for c in ['Debug','Release']]
cl=add('projectconfigs',f'isa = XCConfigurationList; buildConfigurations = ({",".join(configs)}); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release;')
proj=add('project',f'isa = PBXProject; attributes = {{LastUpgradeCheck = 2700;}}; buildConfigurationList = {cl}; compatibilityVersion = "Xcode 15.0"; developmentRegion = en; hasScannedForEncodings = 0; knownRegions = (en,Base); mainGroup = {group}; productRefGroup = {pg}; projectDirPath = ""; projectRoot = ""; targets = ({",".join(targets)}); packageReferences = ({",".join(packages)});')
p=root/'Fotoro.xcodeproj';p.mkdir(exist_ok=True)
(p/'project.pbxproj').write_text('// !$*UTF8*$!\n{archiveVersion = 1; classes = {}; objectVersion = 60; objects = {\n'+''.join(k+' = {'+v+'};\n' for k,v in objects.items())+'}; rootObject = '+proj+';}')
s=p/'xcshareddata/xcschemes';s.mkdir(parents=True,exist_ok=True)
ref=lambda t:f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{uid(t+"Target")}" BuildableName="{t}.{"app" if t in ["Fotoro","FotoroLocalPreview"] else "xctest"}" BlueprintName="{t}" ReferencedContainer="container:Fotoro.xcodeproj"/>'
for app,tests in [('Fotoro','FotoroTests'),('FotoroLocalPreview','FotoroLocalPreviewTests')]:
 (s/(app+'.xcscheme')).write_text(f'<Scheme LastUpgradeVersion="2700" version="1.3"><BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">{ref(app)}</BuildActionEntry></BuildActionEntries></BuildAction><TestAction buildConfiguration="Debug"><Testables><TestableReference skipped="NO">{ref(tests)}</TestableReference></Testables></TestAction><LaunchAction buildConfiguration="Debug" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES"><BuildableProductRunnable runnableDebuggingMode="0">{ref(app)}</BuildableProductRunnable></LaunchAction><ProfileAction buildConfiguration="Release"><BuildableProductRunnable runnableDebuggingMode="0">{ref(app)}</BuildableProductRunnable></ProfileAction><AnalyzeAction buildConfiguration="Debug"/><ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/></Scheme>')
